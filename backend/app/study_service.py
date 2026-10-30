"""Grounded quiz and flashcard generation backed by the existing RAG index."""

import json
import re
from datetime import datetime, timezone
from typing import Any, Literal, Optional

from fastapi import HTTPException, status
from pydantic import BaseModel, ConfigDict, Field, StrictBool, ValidationError, field_validator, model_validator

from backend.app.auth import supabase_admin
from backend.app.embeddings import generate_embedding
from backend.app.gemini_service import GeminiAPIError, generate_text
from backend.app.vector_store import search_similar_chunks


StudyKind = Literal["mcq", "short_answer", "flashcard"]
Difficulty = Literal["easy", "medium", "hard"]


class StudyGenerationRequest(BaseModel):
    source_type: Literal["document", "course"]
    source_id: str = Field(..., min_length=1, max_length=100)
    kind: StudyKind
    difficulty: Difficulty = "medium"
    count: int = Field(default=10, ge=1, le=20)
    focus: Optional[str] = Field(default=None, max_length=300)
    parent_set_id: Optional[str] = None


class GeneratedQuestion(BaseModel):
    model_config = ConfigDict(extra="forbid")

    prompt: str = Field(..., min_length=4, max_length=1200)
    options: list[str] = Field(default_factory=list, max_length=6)
    correct_answer: str = Field(..., min_length=1, max_length=1200)
    explanation: str = Field(..., min_length=4, max_length=1500)
    source_ids: list[str] = Field(..., min_length=1, max_length=5)

    @field_validator("options")
    @classmethod
    def validate_options(cls, options: list[str]) -> list[str]:
        clean = [option.strip() for option in options]
        if any(not option for option in clean):
            raise ValueError("Answer options cannot be empty.")
        if len({normalize_text(option) for option in clean}) != len(clean):
            raise ValueError("Answer options must be unique.")
        return clean

    @model_validator(mode="after")
    def validate_mcq_answer(self) -> "GeneratedQuestion":
        if self.options and normalize_text(self.correct_answer) not in {
            normalize_text(option) for option in self.options
        }:
            raise ValueError("MCQ answer must match one of the options.")
        return self


class GeneratedStudyContent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(..., min_length=2, max_length=120)
    questions: list[GeneratedQuestion] = Field(..., min_length=1, max_length=20)


class AnswerGrade(BaseModel):
    model_config = ConfigDict(extra="forbid")

    is_correct: StrictBool
    feedback: str = Field(..., min_length=2, max_length=1000)


def normalize_text(value: str) -> str:
    """Normalize answer/question text for duplicate detection and exact MCQ grading."""
    return re.sub(r"[^a-z0-9]+", " ", value.casefold()).strip()


def validate_generated_content(
    raw_content: str,
    *,
    expected_count: int,
    kind: StudyKind,
    allowed_source_ids: set[str],
) -> GeneratedStudyContent:
    """Parse and validate structured model output before writing any rows."""
    try:
        content = GeneratedStudyContent.model_validate_json(raw_content)
    except (ValidationError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="The AI returned malformed study content. Please try generating it again.",
        ) from exc

    if len(content.questions) != expected_count:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"The AI returned {len(content.questions)} questions; {expected_count} were requested.",
        )

    seen: set[str] = set()
    for question in content.questions:
        normalized = normalize_text(question.prompt)
        if not normalized or normalized in seen:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="The AI returned duplicate questions. Please try generating the set again.",
            )
        seen.add(normalized)

        if kind == "mcq" and len(question.options) < 2:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="The AI returned an MCQ without enough answer options.",
            )
        if kind != "mcq" and question.options:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="The AI returned answer options for a non-MCQ question.",
            )
        if kind == "flashcard" and len(question.prompt) > 400:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="The AI returned a flashcard front that is too long.",
            )
        if not set(question.source_ids).issubset(allowed_source_ids):
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="The AI cited passages that were not provided to it.",
            )

    return content


def _get_source_resources(student_id: str, request: StudyGenerationRequest) -> list[dict[str, Any]]:
    if request.source_type == "document":
        result = (
            supabase_admin.from_("resources")
            .select("id, student_id, file_name, course, is_indexed, processing_status")
            .eq("id", request.source_id)
            .eq("student_id", student_id)
            .execute()
        )
        resources = result.data or []
    else:
        result = (
            supabase_admin.from_("resources")
            .select("id, student_id, file_name, course, is_indexed, processing_status")
            .eq("course", request.source_id)
            .eq("student_id", student_id)
            .eq("is_indexed", True)
            .execute()
        )
        resources = result.data or []

    if not resources:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No uploaded documents were found for this selection.",
        )

    if any(resource.get("student_id") != student_id for resource in resources):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Source not found.")

    indexed = [resource for resource in resources if resource.get("is_indexed")]
    if request.source_type == "document" and not indexed:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="The selected document is not indexed yet.",
        )
    if not indexed:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="No indexed documents are available for this course.",
        )
    return indexed[:20]


def retrieve_study_sources(
    student_id: str,
    request: StudyGenerationRequest,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Retrieve grounding passages from the existing student-isolated pgvector index."""
    resources = _get_source_resources(student_id, request)
    resource_names = {resource["id"]: resource["file_name"] for resource in resources}
    resource_ids = set(resource_names)
    focus = request.focus or f"Key concepts, definitions, examples, and procedures for {request.source_id}"
    query_vector = generate_embedding(focus)

    retrieved: list[dict[str, Any]] = []
    for resource in resources:
        chunks = search_similar_chunks(
            student_id=student_id,
            query_vector=query_vector,
            resource_id=resource["id"],
            top_k=5,
            threshold=0.15,
        )
        for chunk in chunks:
            if chunk.get("resource_id") not in resource_ids:
                continue
            retrieved.append(chunk)

    retrieved.sort(key=lambda chunk: float(chunk.get("similarity", 0)), reverse=True)
    unique_chunks: list[dict[str, Any]] = []
    seen_chunks: set[tuple[str, int]] = set()
    for chunk in retrieved:
        key = (chunk["resource_id"], int(chunk["chunk_index"]))
        if key in seen_chunks:
            continue
        seen_chunks.add(key)
        unique_chunks.append(chunk)

    if not unique_chunks:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="There is not enough indexed document content to generate questions.",
        )

    source_map: list[dict[str, Any]] = []
    context_parts: list[str] = []
    for index, chunk in enumerate(unique_chunks[:12], start=1):
        source_id = f"S{index}"
        resource_id = chunk["resource_id"]
        source = {
            "source_id": source_id,
            "resource_id": resource_id,
            "file_name": resource_names[resource_id],
            "course": next(
                item["course"] for item in resources if item["id"] == resource_id
            ),
            "page_number": chunk.get("page_number"),
            "chunk_index": int(chunk["chunk_index"]),
            "similarity": round(float(chunk.get("similarity", 0)), 3),
            "excerpt": str(chunk["content"])[:240],
        }
        source_map.append(source)
        context_parts.append(f"[{source_id}] {chunk['content']}")

    return source_map, context_parts


def _call_gemini_json(messages: list[dict[str, str]], max_tokens: int) -> str:
    try:
        return generate_text(messages, max_tokens=max_tokens, json_mode=True)
    except GeminiAPIError as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail=str(exc),
        ) from exc


def generate_questions(
    request: StudyGenerationRequest,
    context_parts: list[str],
    allowed_source_ids: set[str],
) -> GeneratedStudyContent:
    kind_instructions = {
        "mcq": "Create multiple-choice questions with 2 to 5 distinct options.",
        "short_answer": "Create short-answer questions. Do not include choices.",
        "flashcard": "Create flashcards: prompt is a concise front and correct_answer is the concise back. Do not include choices.",
    }
    prompt = (
        "Create a study set using ONLY the supplied source passages. Never add facts from general knowledge. "
        "Return a JSON object with exactly these top-level keys: title, questions. "
        "Every question must contain prompt, options, correct_answer, explanation, source_ids. "
        "source_ids must contain one or more provided source labels such as S1. "
        f"Create exactly {request.count} items at {request.difficulty} difficulty. "
        f"{kind_instructions[request.kind]}\n\n"
        f"Source passages:\n{chr(10).join(context_parts)}"
    )
    raw = _call_gemini_json(
        [
            {"role": "system", "content": "You generate accurate, source-grounded study material as valid JSON only."},
            {"role": "user", "content": prompt},
        ],
        max_tokens=min(7000, 500 + request.count * 300),
    )
    return validate_generated_content(
        raw,
        expected_count=request.count,
        kind=request.kind,
        allowed_source_ids=allowed_source_ids,
    )


def _source_refs(source_ids: list[str], source_map: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_id = {source["source_id"]: source for source in source_map}
    return [{key: value for key, value in by_id[source_id].items() if key != "source_id"} for source_id in source_ids]


def persist_study_set(
    student_id: str,
    request: StudyGenerationRequest,
    content: GeneratedStudyContent,
    source_map: list[dict[str, Any]],
) -> dict[str, Any]:
    parent_id = request.parent_set_id
    if parent_id:
        parent = (
            supabase_admin.from_("study_sets")
            .select("id")
            .eq("id", parent_id)
            .eq("student_id", student_id)
            .execute()
        )
        if not parent.data:
            raise HTTPException(status_code=404, detail="Parent study set not found.")

    first_resource = source_map[0] if source_map else {}
    payload = {
        "student_id": student_id,
        "resource_id": first_resource.get("resource_id") if request.source_type == "document" else None,
        "course": request.source_id if request.source_type == "course" else first_resource.get("course"),
        "title": content.title,
        "content_type": request.kind,
        "difficulty": request.difficulty,
        "question_count": len(content.questions),
        "parent_set_id": parent_id,
    }
    set_result = supabase_admin.from_("study_sets").insert(payload).execute()
    if not set_result.data:
        raise HTTPException(status_code=502, detail="Could not save the generated study set.")
    study_set_id = set_result.data[0]["id"]

    question_rows = []
    key_rows = []
    for position, question in enumerate(content.questions, start=1):
        question_rows.append({
            "study_set_id": study_set_id,
            "student_id": student_id,
            "position": position,
            "prompt": question.prompt,
            "options": question.options,
            "source_refs": _source_refs(question.source_ids, source_map),
        })
    try:
        question_result = supabase_admin.from_("study_questions").insert(question_rows).execute()
        if not question_result.data or len(question_result.data) != len(content.questions):
            raise RuntimeError("Question persistence returned an incomplete result.")
        for position, row in enumerate(question_result.data, start=1):
            row_position = row.get("position", position)
            question = content.questions[row_position - 1]
            key_rows.append({
                "question_id": row["id"],
                "student_id": student_id,
                "correct_answer": question.correct_answer,
                "explanation": question.explanation,
            })
        key_result = supabase_admin.from_("study_answer_keys").insert(key_rows).execute()
        if not key_result.data or len(key_result.data) != len(key_rows):
            raise RuntimeError("Answer key persistence returned an incomplete result.")
    except Exception as exc:
        supabase_admin.from_("study_sets").delete().eq("id", study_set_id).eq("student_id", student_id).execute()
        raise HTTPException(
            status_code=502,
            detail="Could not save all generated questions. No partial study set was kept.",
        ) from exc

    return {
        "id": study_set_id,
        "title": content.title,
        "content_type": request.kind,
        "difficulty": request.difficulty,
        "question_count": len(content.questions),
    }


def get_owned_study_set(student_id: str, study_set_id: str) -> dict[str, Any]:
    result = (
        supabase_admin.from_("study_sets")
        .select("*")
        .eq("id", study_set_id)
        .eq("student_id", student_id)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Study set not found.")
    return result.data[0]


def get_public_questions(student_id: str, study_set_id: str) -> list[dict[str, Any]]:
    result = (
        supabase_admin.from_("study_questions")
        .select("id, position, prompt, options, source_refs")
        .eq("study_set_id", study_set_id)
        .eq("student_id", student_id)
        .order("position")
        .execute()
    )
    return result.data or []


def create_attempt(student_id: str, study_set_id: str) -> dict[str, Any]:
    study_set = get_owned_study_set(student_id, study_set_id)
    if study_set["content_type"] == "flashcard":
        raise HTTPException(status_code=400, detail="Flashcard sets do not have quiz attempts.")
    result = supabase_admin.from_("study_attempts").insert({
        "study_set_id": study_set_id,
        "student_id": student_id,
        "total_questions": study_set["question_count"],
    }).execute()
    if not result.data:
        raise HTTPException(status_code=502, detail="Could not start the quiz attempt.")
    return {"attempt": result.data[0], "questions": get_public_questions(student_id, study_set_id)}


def resume_attempt(student_id: str, attempt_id: str) -> dict[str, Any]:
    attempt_result = (
        supabase_admin.from_("study_attempts")
        .select("*")
        .eq("id", attempt_id)
        .eq("student_id", student_id)
        .execute()
    )
    if not attempt_result.data:
        raise HTTPException(status_code=404, detail="Quiz attempt not found.")
    attempt = attempt_result.data[0]
    study_set = get_owned_study_set(student_id, attempt["study_set_id"])
    questions = get_public_questions(student_id, attempt["study_set_id"])
    responses = (
        supabase_admin.from_("study_responses")
        .select("question_id, is_correct")
        .eq("attempt_id", attempt_id)
        .eq("student_id", student_id)
        .execute()
    ).data or []
    return {
        "attempt": attempt,
        "study_set": study_set,
        "questions": questions,
        "answered_count": len(responses),
        "complete": bool(attempt.get("completed_at")),
    }


def _grade_short_answer(answer: str, correct_answer: str, explanation: str, question: str) -> AnswerGrade:
    raw = _call_gemini_json(
        [
            {
                "role": "system",
                "content": (
                    "Grade a student's answer against the reference answer. Accept semantically equivalent "
                    "answers supported by the reference. Return JSON with exactly is_correct (boolean) and "
                    "feedback (string). Do not use knowledge outside the reference."
                ),
            },
            {
                "role": "user",
                "content": json.dumps({
                    "question": question,
                    "reference_answer": correct_answer,
                    "explanation": explanation,
                    "student_answer": answer,
                }),
            },
        ],
        max_tokens=300,
    )
    try:
        return AnswerGrade.model_validate_json(raw)
    except (ValidationError, ValueError) as exc:
        raise HTTPException(
            status_code=502,
            detail="The AI returned an invalid grading response. Please submit this answer again.",
        ) from exc


def submit_answer(
    student_id: str,
    attempt_id: str,
    question_id: str,
    answer: str,
) -> dict[str, Any]:
    answer = answer.strip()
    if not answer or len(answer) > 2000:
        raise HTTPException(status_code=422, detail="Answer must be between 1 and 2000 characters.")

    attempt_result = (
        supabase_admin.from_("study_attempts")
        .select("*")
        .eq("id", attempt_id)
        .eq("student_id", student_id)
        .execute()
    )
    if not attempt_result.data:
        raise HTTPException(status_code=404, detail="Quiz attempt not found.")
    attempt = attempt_result.data[0]
    if attempt.get("completed_at"):
        raise HTTPException(status_code=409, detail="This quiz attempt is already complete.")

    questions = get_public_questions(student_id, attempt["study_set_id"])
    question_index = next((i for i, question in enumerate(questions) if question["id"] == question_id), None)
    if question_index is None:
        raise HTTPException(status_code=404, detail="Question not found in this quiz.")

    responses = (
        supabase_admin.from_("study_responses")
        .select("question_id, is_correct")
        .eq("attempt_id", attempt_id)
        .eq("student_id", student_id)
        .execute()
    ).data or []
    if any(response["question_id"] == question_id for response in responses):
        raise HTTPException(status_code=409, detail="This question has already been answered.")
    expected_index = len(responses)
    if question_index != expected_index:
        raise HTTPException(status_code=409, detail="Answer the quiz questions in order.")

    question = questions[question_index]
    key_result = (
        supabase_admin.from_("study_answer_keys")
        .select("correct_answer, explanation")
        .eq("question_id", question_id)
        .eq("student_id", student_id)
        .execute()
    )
    if not key_result.data:
        raise HTTPException(status_code=500, detail="The answer key for this question is unavailable.")
    key = key_result.data[0]

    if question.get("options"):
        is_correct = normalize_text(answer) == normalize_text(key["correct_answer"])
        feedback = "Correct." if is_correct else "Review the explanation and source passage."
    else:
        grade = _grade_short_answer(answer, key["correct_answer"], key["explanation"], question["prompt"])
        is_correct = grade.is_correct
        feedback = grade.feedback

    try:
        recorded = supabase_admin.rpc("record_study_response", {
            "p_attempt_id": attempt_id,
            "p_question_id": question_id,
            "p_student_id": student_id,
            "p_answer": answer,
            "p_is_correct": is_correct,
            "p_feedback": feedback,
        }).execute()
    except Exception as exc:
        error_text = str(exc).casefold()
        if any(message in error_text for message in (
            "already answered",
            "answer the quiz questions in order",
            "attempt is already complete",
        )):
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        raise HTTPException(status_code=502, detail="Could not save quiz progress. Please retry.") from exc

    record = (recorded.data or [None])[0]
    if not record:
        raise HTTPException(status_code=502, detail="Could not save quiz progress.")

    return {
        "question_id": question_id,
        "is_correct": is_correct,
        "feedback": feedback,
        "correct_answer": key["correct_answer"],
        "explanation": key["explanation"],
        "source_refs": question.get("source_refs", []),
        "answered_count": record["answered_count"],
        "total_questions": record["total_questions"],
        "correct_count": record["correct_count"],
        "score": float(record["score"]),
        "complete": record["complete"],
    }


def list_attempts(student_id: str) -> list[dict[str, Any]]:
    result = (
        supabase_admin.from_("study_attempts")
        .select("id, study_set_id, score, correct_count, total_questions, started_at, completed_at")
        .eq("student_id", student_id)
        .order("started_at", desc=True)
        .limit(50)
        .execute()
    )
    attempts = result.data or []
    attempt_ids = [attempt["id"] for attempt in attempts]
    response_counts: dict[str, int] = {}
    if attempt_ids:
        response_rows = (
            supabase_admin.from_("study_responses")
            .select("attempt_id")
            .eq("student_id", student_id)
            .in_("attempt_id", attempt_ids)
            .execute()
        ).data or []
        for response in response_rows:
            response_counts[response["attempt_id"]] = response_counts.get(response["attempt_id"], 0) + 1
    attempts = [
        {**attempt, "answered_count": response_counts.get(attempt["id"], 0)}
        for attempt in attempts
    ]
    set_ids = list({attempt["study_set_id"] for attempt in attempts})
    if not set_ids:
        return []
    sets_result = supabase_admin.from_("study_sets").select(
        "id, title, content_type, difficulty, course, resource_id"
    ).eq("student_id", student_id).in_("id", set_ids).execute()
    sets = {study_set["id"]: study_set for study_set in (sets_result.data or [])}
    return [{**attempt, "study_set": sets.get(attempt["study_set_id"])} for attempt in attempts]


def list_study_sets(student_id: str) -> list[dict[str, Any]]:
    result = (
        supabase_admin.from_("study_sets")
        .select("id, title, content_type, difficulty, question_count, course, resource_id, created_at")
        .eq("student_id", student_id)
        .order("created_at", desc=True)
        .limit(50)
        .execute()
    )
    study_sets = result.data or []
    flashcard_sets = [study_set for study_set in study_sets if study_set["content_type"] == "flashcard"]
    if not flashcard_sets:
        return study_sets
    set_ids = [study_set["id"] for study_set in flashcard_sets]
    question_result = (
        supabase_admin.from_("study_questions")
        .select("id, study_set_id")
        .eq("student_id", student_id)
        .in_("study_set_id", set_ids)
        .execute()
    )
    question_to_set = {
        question["id"]: question["study_set_id"] for question in (question_result.data or [])
    }
    question_ids = list(question_to_set)
    review_rows = []
    if question_ids:
        review_rows = (
            supabase_admin.from_("flashcard_reviews")
            .select("question_id, status")
            .eq("student_id", student_id)
            .in_("question_id", question_ids)
            .execute()
        ).data or []
    progress: dict[str, dict[str, int]] = {
        study_set_id: {"known_count": 0, "revise_count": 0}
        for study_set_id in set_ids
    }
    for review in review_rows:
        study_set_id = question_to_set.get(review["question_id"])
        if study_set_id:
            key = "known_count" if review["status"] == "known" else "revise_count"
            progress[study_set_id][key] += 1
    return [
        {**study_set, **progress.get(study_set["id"], {})}
        for study_set in study_sets
    ]


def generate_missed_practice(
    student_id: str,
    attempt_id: str,
    difficulty: Difficulty,
    count: int,
) -> dict[str, Any]:
    attempt_result = (
        supabase_admin.from_("study_attempts")
        .select("id, study_set_id")
        .eq("id", attempt_id)
        .eq("student_id", student_id)
        .execute()
    )
    if not attempt_result.data:
        raise HTTPException(status_code=404, detail="Quiz attempt not found.")
    attempt = attempt_result.data[0]
    missed = (
        supabase_admin.from_("study_responses")
        .select("question_id")
        .eq("attempt_id", attempt_id)
        .eq("student_id", student_id)
        .eq("is_correct", False)
        .execute()
    ).data or []
    if not missed:
        raise HTTPException(status_code=400, detail="There are no missed questions to practise.")

    missed_ids = [response["question_id"] for response in missed]
    missed_questions = (
        supabase_admin.from_("study_questions")
        .select("prompt")
        .eq("student_id", student_id)
        .in_("id", missed_ids)
        .execute()
    ).data or []
    parent = get_owned_study_set(student_id, attempt["study_set_id"])
    if parent.get("resource_id"):
        source_type, source_id = "document", parent["resource_id"]
    elif parent.get("course"):
        source_type, source_id = "course", parent["course"]
    else:
        raise HTTPException(status_code=409, detail="The source for this quiz is unavailable.")

    focus = "Generate new practice about these missed concepts: " + "; ".join(
        question["prompt"] for question in missed_questions
    )
    request = StudyGenerationRequest(
        source_type=source_type,
        source_id=source_id,
        kind=parent["content_type"],
        difficulty=difficulty,
        count=count,
        focus=focus,
        parent_set_id=parent["id"],
    )
    source_map, context = retrieve_study_sources(student_id, request)
    content = generate_questions(request, context, {source["source_id"] for source in source_map})
    study_set = persist_study_set(student_id, request, content, source_map)
    if request.kind == "flashcard":
        return {"study_set": study_set, "attempt": None, "questions": []}
    attempt_data = create_attempt(student_id, study_set["id"])
    return {"study_set": study_set, **attempt_data}


def get_flashcards(student_id: str, study_set_id: str) -> list[dict[str, Any]]:
    study_set = get_owned_study_set(student_id, study_set_id)
    if study_set["content_type"] != "flashcard":
        raise HTTPException(status_code=400, detail="This study set is not a flashcard set.")
    questions = get_public_questions(student_id, study_set_id)
    ids = [question["id"] for question in questions]
    if not ids:
        return []
    reviews_result = (
        supabase_admin.from_("flashcard_reviews")
        .select("question_id, status")
        .eq("student_id", student_id)
        .in_("question_id", ids)
        .execute()
    )
    reviews = {review["question_id"]: review["status"] for review in (reviews_result.data or [])}
    return [{**question, "review_status": reviews.get(question["id"], "new")} for question in questions]


def reveal_flashcard(student_id: str, study_set_id: str, question_id: str) -> dict[str, Any]:
    study_set = get_owned_study_set(student_id, study_set_id)
    if study_set["content_type"] != "flashcard":
        raise HTTPException(status_code=400, detail="This study set is not a flashcard set.")
    question = (
        supabase_admin.from_("study_questions")
        .select("id")
        .eq("id", question_id)
        .eq("study_set_id", study_set_id)
        .eq("student_id", student_id)
        .execute()
    )
    if not question.data:
        raise HTTPException(status_code=404, detail="Flashcard not found.")
    key = (
        supabase_admin.from_("study_answer_keys")
        .select("correct_answer, explanation")
        .eq("question_id", question_id)
        .eq("student_id", student_id)
        .execute()
    )
    if not key.data:
        raise HTTPException(status_code=500, detail="The flashcard answer is unavailable.")
    return key.data[0]


def mark_flashcard(student_id: str, study_set_id: str, question_id: str, review_status: str) -> dict[str, Any]:
    if review_status not in {"known", "revise"}:
        raise HTTPException(status_code=422, detail="Review status must be known or revise.")
    study_set = get_owned_study_set(student_id, study_set_id)
    if study_set["content_type"] != "flashcard":
        raise HTTPException(status_code=400, detail="This study set is not a flashcard set.")
    owned_question = (
        supabase_admin.from_("study_questions")
        .select("id")
        .eq("id", question_id)
        .eq("study_set_id", study_set_id)
        .eq("student_id", student_id)
        .execute()
    )
    if not owned_question.data:
        raise HTTPException(status_code=404, detail="Flashcard not found.")
    result = supabase_admin.from_("flashcard_reviews").upsert(
        {
            "student_id": student_id,
            "question_id": question_id,
            "status": review_status,
            "reviewed_at": datetime.now(timezone.utc).isoformat(),
        },
        on_conflict="student_id,question_id",
    ).select("question_id, status, reviewed_at").execute()
    if not result.data:
        raise HTTPException(status_code=502, detail="Could not save flashcard progress.")
    return result.data[0]
