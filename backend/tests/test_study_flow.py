"""Tests for grounded study-set generation, privacy, scoring, and flashcard progress."""

from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from backend.app import study_service
from backend.app.auth import get_current_student
from backend.app.main import app


class FakeSupabase:
    def __init__(self):
        self.tables = {
            "resources": [],
            "study_sets": [],
            "study_questions": [],
            "study_answer_keys": [],
            "study_attempts": [],
            "study_responses": [],
            "flashcard_reviews": [],
        }

    def from_(self, table):
        return FakeQuery(self, table)

    def rpc(self, name, params):
        return SimpleNamespace(execute=lambda: self.execute_rpc(name, params))

    def execute_rpc(self, name, params):
        assert name == "record_study_response"
        attempt = next(
            row for row in self.tables["study_attempts"]
            if row["id"] == params["p_attempt_id"]
            and row["student_id"] == params["p_student_id"]
        )
        questions = sorted(
            (
                row for row in self.tables["study_questions"]
                if row["study_set_id"] == attempt["study_set_id"]
                and row["student_id"] == params["p_student_id"]
            ),
            key=lambda row: row["position"],
        )
        response = {
            "attempt_id": params["p_attempt_id"],
            "question_id": params["p_question_id"],
            "student_id": params["p_student_id"],
            "answer": params["p_answer"],
            "is_correct": params["p_is_correct"],
            "points": int(params["p_is_correct"]),
            "feedback": params["p_feedback"],
            "id": str(uuid4()),
        }
        self.tables["study_responses"].append(response)
        attempt_responses = [
            row for row in self.tables["study_responses"]
            if row["attempt_id"] == params["p_attempt_id"]
            and row["student_id"] == params["p_student_id"]
        ]
        correct_count = sum(bool(row["is_correct"]) for row in attempt_responses)
        total = attempt["total_questions"]
        complete = len(attempt_responses) == total
        score = round(correct_count * 100 / total, 1)
        attempt["correct_count"] = correct_count
        attempt["score"] = score
        if complete:
            attempt["completed_at"] = "completed"
        return SimpleNamespace(data=[{
            "question_id": params["p_question_id"],
            "answered_count": len(attempt_responses),
            "total_questions": len(questions),
            "correct_count": correct_count,
            "score": score,
            "complete": complete,
        }])


class FakeQuery:
    def __init__(self, client, table):
        self.client = client
        self.table = table
        self.filters = []
        self.operation = "select"
        self.payload = None
        self.columns = "*"
        self.returning = False

    def select(self, columns="*"):
        self.columns = columns
        self.returning = True
        return self

    def eq(self, key, value):
        self.filters.append((key, value))
        return self

    def in_(self, key, values):
        self.filters.append((key, set(values)))
        return self

    def order(self, *_args, **_kwargs):
        return self

    def limit(self, *_args, **_kwargs):
        return self

    def insert(self, payload):
        self.operation = "insert"
        self.payload = payload
        return self

    def upsert(self, payload, **_kwargs):
        self.operation = "upsert"
        self.payload = payload
        return self

    def update(self, payload):
        self.operation = "update"
        self.payload = payload
        return self

    def delete(self):
        self.operation = "delete"
        return self

    def execute(self):
        rows = self.client.tables[self.table]
        matching = [row for row in rows if self._matches(row)]
        if self.operation in ("insert", "upsert"):
            payloads = self.payload if isinstance(self.payload, list) else [self.payload]
            inserted = []
            for payload in payloads:
                row = dict(payload)
                row.setdefault("id", str(uuid4()))
                if self.table == "study_attempts":
                    row.setdefault("correct_count", 0)
                    row.setdefault("completed_at", None)
                if self.operation == "upsert" and self.table == "flashcard_reviews":
                    existing = next(
                        (
                            current for current in rows
                            if current["student_id"] == row["student_id"]
                            and current["question_id"] == row["question_id"]
                        ),
                        None,
                    )
                    if existing:
                        existing.update(row)
                        inserted.append(existing)
                        continue
                rows.append(row)
                inserted.append(row)
            return SimpleNamespace(data=inserted)
        if self.operation == "update":
            for row in matching:
                row.update(self.payload)
            return SimpleNamespace(data=matching if self.returning else None)
        if self.operation == "delete":
            self.client.tables[self.table] = [row for row in rows if row not in matching]
            return SimpleNamespace(data=matching)
        if self.columns == "*":
            selected = [dict(row) for row in matching]
        else:
            keys = [column.strip() for column in self.columns.split(",")]
            selected = [{key: row[key] for key in keys if key in row} for row in matching]
        return SimpleNamespace(data=selected)

    def _matches(self, row):
        for key, expected in self.filters:
            actual = row.get(key)
            if isinstance(expected, set):
                if actual not in expected:
                    return False
            elif actual != expected:
                return False
        return True


STUDENT_ID = "student-a"
SOURCE = {
    "source_id": "S1",
    "resource_id": "resource-a",
    "file_name": "lecture.pdf",
    "page_number": 2,
    "chunk_index": 0,
    "similarity": 0.88,
    "excerpt": "A software contract describes...",
}


def build_content(kind="mcq"):
    questions = []
    for index in range(2):
        questions.append({
            "prompt": f"What does contract term {index + 1} describe?",
            "options": ["Scope", "Price", "Schedule"] if kind == "mcq" else [],
            "correct_answer": "Scope" if kind == "mcq" else f"Contract answer {index + 1}",
            "explanation": f"The lecture says term {index + 1} describes scope.",
            "source_ids": ["S1"],
        })
    return study_service.GeneratedStudyContent.model_validate({
        "title": "Software contract review",
        "questions": questions,
    })


@pytest.fixture
def fake_db(monkeypatch):
    database = FakeSupabase()
    monkeypatch.setattr(study_service, "supabase_admin", database)
    return database


@pytest.fixture
def api_client():
    app.dependency_overrides[get_current_student] = lambda: {
        "id": STUDENT_ID,
        "email": "student@example.com",
    }
    with TestClient(app) as client:
        yield client
    app.dependency_overrides.clear()


def patch_generation(monkeypatch, kind="mcq"):
    monkeypatch.setattr(
        study_service,
        "retrieve_study_sources",
        lambda _student_id, _request: ([SOURCE], ["[S1] A software contract describes scope and obligations."]),
    )
    monkeypatch.setattr(
        study_service,
        "generate_questions",
        lambda _request, _context, _sources: build_content(kind),
    )


def test_generated_json_is_validated_and_duplicate_questions_rejected():
    raw = build_content().model_dump_json()
    validated = study_service.validate_generated_content(
        raw,
        expected_count=2,
        kind="mcq",
        allowed_source_ids={"S1"},
    )
    assert len(validated.questions) == 2

    duplicate = {
        "title": "Duplicate set",
        "questions": [
            {
                "prompt": "Same question?",
                "options": ["A", "B"],
                "correct_answer": "A",
                "explanation": "A is stated in the notes.",
                "source_ids": ["S1"],
            },
            {
                "prompt": "Same question!",
                "options": ["A", "B"],
                "correct_answer": "A",
                "explanation": "A is stated in the notes.",
                "source_ids": ["S1"],
            },
        ],
    }
    with pytest.raises(HTTPException) as error:
        study_service.validate_generated_content(
            str(__import__("json").dumps(duplicate)),
            expected_count=2,
            kind="mcq",
            allowed_source_ids={"S1"},
        )
    assert error.value.status_code == 502


def test_generation_uses_retrieved_passages_and_structured_json(monkeypatch):
    observed = {}

    def fake_json_call(messages, max_tokens):
        observed["messages"] = messages
        observed["max_tokens"] = max_tokens
        return build_content().model_dump_json()

    monkeypatch.setattr(study_service, "_call_groq_json", fake_json_call)
    request = study_service.StudyGenerationRequest(
        source_type="document",
        source_id="resource-a",
        kind="mcq",
        count=2,
    )
    result = study_service.generate_questions(
        request,
        ["[S1] A software contract describes scope and obligations."],
        {"S1"},
    )
    assert len(result.questions) == 2
    assert "[S1] A software contract describes scope and obligations." in observed["messages"][1]["content"]
    assert observed["max_tokens"] == 1100


@pytest.mark.parametrize("raw", ["not json", '{"title":"x","questions":[]}'])
def test_malformed_or_wrong_count_ai_response_is_rejected(raw):
    with pytest.raises(HTTPException) as error:
        study_service.validate_generated_content(
            raw,
            expected_count=2,
            kind="short_answer",
            allowed_source_ids={"S1"},
        )
    assert error.value.status_code == 502


def test_question_cannot_cite_unprovided_passages():
    data = build_content().model_dump()
    data["questions"][0]["source_ids"] = ["S99"]
    with pytest.raises(HTTPException) as error:
        study_service.validate_generated_content(
            __import__("json").dumps(data),
            expected_count=2,
            kind="mcq",
            allowed_source_ids={"S1"},
        )
    assert error.value.status_code == 502


def test_invalid_generated_content_is_not_persisted(api_client, fake_db, monkeypatch):
    patch_generation(monkeypatch)
    monkeypatch.setattr(
        study_service,
        "generate_questions",
        lambda *_args: (_ for _ in ()).throw(HTTPException(status_code=502, detail="Invalid AI JSON")),
    )
    response = api_client.post(
        "/api/study/generate",
        json={"source_type": "document", "source_id": "resource-a", "kind": "mcq", "count": 2},
    )
    assert response.status_code == 502
    assert fake_db.tables["study_sets"] == []
    assert fake_db.tables["study_questions"] == []
    assert fake_db.tables["study_answer_keys"] == []


def test_document_source_lookup_is_student_scoped(fake_db):
    fake_db.tables["resources"].append({
        "id": "resource-b",
        "student_id": "student-b",
        "file_name": "private.pdf",
        "course": "DBMS",
        "is_indexed": True,
    })
    request = study_service.StudyGenerationRequest(
        source_type="document",
        source_id="resource-b",
        kind="mcq",
        count=1,
    )
    with pytest.raises(HTTPException) as error:
        study_service.retrieve_study_sources(STUDENT_ID, request)
    assert error.value.status_code == 404


def test_course_retrieval_reuses_existing_embedding_and_vector_search(fake_db, monkeypatch):
    fake_db.tables["resources"].append({
        "id": "resource-a",
        "student_id": STUDENT_ID,
        "file_name": "lecture.pdf",
        "course": "Software Engineering",
        "is_indexed": True,
    })
    embedding_calls = []
    search_calls = []
    monkeypatch.setattr(
        study_service,
        "generate_embedding",
        lambda text: embedding_calls.append(text) or [0.1, 0.2],
    )
    monkeypatch.setattr(
        study_service,
        "search_similar_chunks",
        lambda **kwargs: search_calls.append(kwargs) or [{
            "resource_id": "resource-a",
            "chunk_index": 3,
            "page_number": 2,
            "content": "The contract defines scope and obligations.",
            "similarity": 0.8,
        }],
    )
    request = study_service.StudyGenerationRequest(
        source_type="course",
        source_id="Software Engineering",
        kind="mcq",
        count=1,
        focus="Contract types",
    )
    sources, context = study_service.retrieve_study_sources(STUDENT_ID, request)
    assert embedding_calls == ["Contract types"]
    assert search_calls[0]["student_id"] == STUDENT_ID
    assert search_calls[0]["resource_id"] == "resource-a"
    assert sources[0]["file_name"] == "lecture.pdf"
    assert context[0].startswith("[S1]")


def test_short_answer_grader_rejects_malformed_json(monkeypatch):
    monkeypatch.setattr(study_service, "_call_groq_json", lambda *_args, **_kwargs: '{"is_correct": true}')
    with pytest.raises(HTTPException) as error:
        study_service._grade_short_answer(
            "Student response",
            "Reference response",
            "Explanation",
            "Question?",
        )
    assert error.value.status_code == 502


def test_short_answer_is_graded_and_persisted(fake_db, monkeypatch):
    set_id, attempt_id, question_id = (str(uuid4()) for _ in range(3))
    fake_db.tables["study_sets"].append({
        "id": set_id,
        "student_id": STUDENT_ID,
        "content_type": "short_answer",
        "question_count": 1,
        "title": "Short answer set",
    })
    fake_db.tables["study_questions"].append({
        "id": question_id,
        "student_id": STUDENT_ID,
        "study_set_id": set_id,
        "position": 1,
        "prompt": "What does this contract define?",
        "options": [],
        "source_refs": [SOURCE],
    })
    fake_db.tables["study_answer_keys"].append({
        "question_id": question_id,
        "student_id": STUDENT_ID,
        "correct_answer": "Scope and obligations",
        "explanation": "The source passage describes both.",
    })
    fake_db.tables["study_attempts"].append({
        "id": attempt_id,
        "student_id": STUDENT_ID,
        "study_set_id": set_id,
        "total_questions": 1,
        "completed_at": None,
    })
    monkeypatch.setattr(
        study_service,
        "_grade_short_answer",
        lambda *_args: study_service.AnswerGrade(is_correct=True, feedback="Equivalent meaning."),
    )
    result = study_service.submit_answer(STUDENT_ID, attempt_id, question_id, "It defines obligations and scope.")
    assert result["is_correct"] is True
    assert result["score"] == 100
    assert fake_db.tables["study_responses"][0]["answer"] == "It defines obligations and scope."


def test_generation_attempt_scoring_and_answer_key_privacy(api_client, fake_db, monkeypatch):
    patch_generation(monkeypatch)
    response = api_client.post(
        "/api/study/generate",
        json={
            "source_type": "document",
            "source_id": "resource-a",
            "kind": "mcq",
            "difficulty": "medium",
            "count": 2,
        },
    )
    assert response.status_code == 200
    result = response.json()
    assert len(result["questions"]) == 2
    assert "correct_answer" not in response.text
    assert len(fake_db.tables["study_answer_keys"]) == 2
    assert result["questions"][0]["source_refs"][0]["file_name"] == "lecture.pdf"

    attempt_id = result["attempt"]["id"]
    first, second = result["questions"]
    first_answer = api_client.post(
        f"/api/study/attempts/{attempt_id}/answers",
        json={"question_id": first["id"], "answer": "Scope"},
    )
    assert first_answer.status_code == 200
    assert first_answer.json()["is_correct"] is True
    assert first_answer.json()["complete"] is False
    progress = api_client.get(f"/api/study/attempts/{attempt_id}")
    assert progress.status_code == 200
    assert progress.json()["answered_count"] == 1
    assert "correct_answer" not in progress.text

    second_answer = api_client.post(
        f"/api/study/attempts/{attempt_id}/answers",
        json={"question_id": second["id"], "answer": "Price"},
    )
    assert second_answer.status_code == 200
    assert second_answer.json()["is_correct"] is False
    assert second_answer.json()["complete"] is True
    assert second_answer.json()["score"] == 50.0
    assert fake_db.tables["study_attempts"][0]["score"] == 50.0
    assert len(fake_db.tables["study_responses"]) == 2
    history = api_client.get("/api/study/attempts").json()["attempts"]
    assert history[0]["score"] == 50.0
    assert history[0]["answered_count"] == 2


def test_attempt_rejects_answer_out_of_order_or_duplicate(api_client, fake_db, monkeypatch):
    patch_generation(monkeypatch)
    result = api_client.post(
        "/api/study/generate",
        json={"source_type": "document", "source_id": "resource-a", "kind": "mcq", "count": 2},
    ).json()
    attempt_id = result["attempt"]["id"]
    first, second = result["questions"]

    out_of_order = api_client.post(
        f"/api/study/attempts/{attempt_id}/answers",
        json={"question_id": second["id"], "answer": "Scope"},
    )
    assert out_of_order.status_code == 409

    payload = {"question_id": first["id"], "answer": "Scope"}
    assert api_client.post(f"/api/study/attempts/{attempt_id}/answers", json=payload).status_code == 200
    duplicate = api_client.post(f"/api/study/attempts/{attempt_id}/answers", json=payload)
    assert duplicate.status_code == 409


def test_other_student_cannot_read_or_submit_an_attempt(fake_db):
    fake_db.tables["study_attempts"].append({
        "id": "attempt-b",
        "student_id": "student-b",
        "study_set_id": "set-b",
        "total_questions": 1,
        "completed_at": None,
    })
    with pytest.raises(HTTPException) as error:
        study_service.submit_answer(STUDENT_ID, "attempt-b", "question-b", "answer")
    assert error.value.status_code == 404


def test_missed_topics_create_a_linked_practice_set(fake_db, monkeypatch):
    parent_id = str(uuid4())
    attempt_id = str(uuid4())
    question_id = str(uuid4())
    fake_db.tables["study_sets"].append({
        "id": parent_id,
        "student_id": STUDENT_ID,
        "content_type": "mcq",
        "course": "Software Engineering",
        "resource_id": None,
        "question_count": 1,
    })
    fake_db.tables["study_attempts"].append({
        "id": attempt_id,
        "student_id": STUDENT_ID,
        "study_set_id": parent_id,
        "total_questions": 1,
        "completed_at": "done",
    })
    fake_db.tables["study_responses"].append({
        "id": str(uuid4()),
        "student_id": STUDENT_ID,
        "attempt_id": attempt_id,
        "question_id": question_id,
        "is_correct": False,
    })
    fake_db.tables["study_questions"].append({
        "id": question_id,
        "student_id": STUDENT_ID,
        "study_set_id": parent_id,
        "position": 1,
        "prompt": "What does a fixed-price contract define?",
        "options": ["Scope", "Price", "Time"],
        "source_refs": [SOURCE],
    })
    observed = {}

    def fake_retrieve(student_id, request):
        observed["student_id"] = student_id
        observed["focus"] = request.focus
        observed["parent_set_id"] = request.parent_set_id
        return [SOURCE], ["[S1] Fixed-price contracts define a fixed price."]

    monkeypatch.setattr(study_service, "retrieve_study_sources", fake_retrieve)
    monkeypatch.setattr(
        study_service,
        "generate_questions",
        lambda *_args: build_content(),
    )
    result = study_service.generate_missed_practice(STUDENT_ID, attempt_id, "hard", 2)
    assert "fixed-price contract" in observed["focus"].lower()
    assert observed["parent_set_id"] == parent_id
    assert result["study_set"]["id"] != parent_id
    assert fake_db.tables["study_sets"][-1]["parent_set_id"] == parent_id


def test_flashcards_reveal_only_on_demand_and_review_is_saved(api_client, fake_db, monkeypatch):
    patch_generation(monkeypatch, kind="flashcard")
    response = api_client.post(
        "/api/study/generate",
        json={
            "source_type": "course",
            "source_id": "Software Engineering",
            "kind": "flashcard",
            "difficulty": "easy",
            "count": 2,
        },
    )
    assert response.status_code == 200
    study_set_id = response.json()["study_set"]["id"]
    assert "correct_answer" not in response.text

    cards = api_client.get(f"/api/study/sets/{study_set_id}/flashcards").json()["flashcards"]
    assert len(cards) == 2
    assert "back" not in cards[0]

    reveal = api_client.post(
        f"/api/study/sets/{study_set_id}/flashcards/{cards[0]['id']}/reveal",
        json={},
    )
    assert reveal.status_code == 200
    assert reveal.json()["correct_answer"] == "Contract answer 1"

    review = api_client.post(
        f"/api/study/sets/{study_set_id}/flashcards/{cards[0]['id']}/review",
        json={"status": "revise"},
    )
    assert review.status_code == 200
    assert fake_db.tables["flashcard_reviews"][0]["status"] == "revise"
    saved_sets = api_client.get("/api/study/sets").json()["study_sets"]
    assert saved_sets[0]["revise_count"] == 1


def test_unauthenticated_study_generation_is_rejected():
    app.dependency_overrides.clear()
    with TestClient(app) as client:
        response = client.post(
            "/api/study/generate",
            json={"source_type": "course", "source_id": "DBMS", "kind": "mcq"},
        )
    assert response.status_code in (401, 403)
