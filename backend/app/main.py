"""
SSAS AI Research & Study Assistant — FastAPI Backend.
Provides authenticated document processing (RAG indexing) and grounded question-answering.
"""

from fastapi import FastAPI, Depends, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Literal

from backend.app.config import settings
from backend.app.gemini_service import GeminiAPIError
from backend.app.auth import get_current_student, supabase_admin
from backend.app.pdf_processor import (
    extract_text_from_file,
    compute_file_hash,
    DocumentExtractionError,
    ScannedPDFError
)
from backend.app.chunker import chunk_pages
from backend.app.embeddings import generate_embedding, generate_embeddings_batch
from backend.app.vector_store import (
    get_student_resource,
    find_existing_by_hash,
    update_resource_status,
    save_chunks_with_embeddings,
    search_similar_chunks
)
from backend.app.rag_service import generate_rag_answer
from backend.app import study_service

app = FastAPI(
    title="SSAS AI Research & Study Assistant API",
    version="1.0.0",
    description="RAG-powered academic assistant for Smart Student Assistance System"
)

# Enable CORS for frontend integration
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Request & Response Models
class ProcessDocumentRequest(BaseModel):
    resource_id: str = Field(..., description="UUID of the resource in Supabase")


class ProcessDocumentResponse(BaseModel):
    success: bool
    resource_id: str
    status: str
    chunk_count: int = 0
    total_pages: int = 0
    message: str


class AskQuestionRequest(BaseModel):
    question: str = Field(..., min_length=2, max_length=600)
    resource_id: Optional[str] = Field(None, description="Optional target document UUID; None searches all student docs")
    chat_history: Optional[List[Dict[str, str]]] = Field(None, description="Recent conversation turns for follow-ups")


class CitationItem(BaseModel):
    file_name: str
    page_number: int
    chunk_index: int
    similarity: float
    excerpt: str


class AskQuestionResponse(BaseModel):
    success: bool
    answer: str
    has_sufficient_evidence: bool
    citations: List[CitationItem]
    document_name: str


class StudyAnswerRequest(BaseModel):
    question_id: str = Field(..., min_length=1)
    answer: str = Field(..., min_length=1, max_length=2000)


class StudyPracticeRequest(BaseModel):
    difficulty: Literal["easy", "medium", "hard"] = "medium"
    count: int = Field(default=5, ge=1, le=20)


class FlashcardReviewRequest(BaseModel):
    status: Literal["known", "revise"]


@app.get("/health")
def health_check():
    gemini_key = settings.GEMINI_API_KEY.strip()
    return {
        "status": "healthy",
        "service": "SSAS RAG Assistant Backend",
        "embedding_model": settings.EMBEDDING_MODEL_NAME,
        "llm_provider": "gemini",
        "llm_model": settings.GEMINI_MODEL,
        "llm_configured": bool(gemini_key and gemini_key != "your_gemini_api_key_here"),
    }


@app.post("/api/process-document", response_model=ProcessDocumentResponse)
def process_document(
    request: ProcessDocumentRequest,
    current_student: dict = Depends(get_current_student)
):
    student_id = current_student["id"]
    resource_id = request.resource_id

    # 1. Verify resource exists and belongs to this student
    resource = get_student_resource(student_id, resource_id)
    if not resource:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Document not found or access denied."
        )

    storage_path = resource.get("storage_path")
    file_name = resource.get("file_name", "document.pdf")

    # Mark as processing
    update_resource_status(resource_id, status="processing")

    try:
        # 2. Download binary file from Supabase Storage
        file_res = supabase_admin.storage.from_("student-resources").download(storage_path)
        if not file_res:
            raise DocumentExtractionError(f"Could not download file from storage: {storage_path}")

        file_bytes = file_res

        # 3. Check duplicate processing using content hash
        file_hash = compute_file_hash(file_bytes)
        existing = find_existing_by_hash(student_id, file_hash)
        if existing and existing["id"] != resource_id:
            # Re-use already computed chunks from the existing identical file
            existing_chunks = supabase_admin.from_("document_chunks") \
                .select("chunk_index, page_number, content, embedding") \
                .eq("resource_id", existing["id"]) \
                .execute()

            if existing_chunks.data and len(existing_chunks.data) > 0:
                reused_rows = []
                for row in existing_chunks.data:
                    reused_rows.append({
                        "student_id": student_id,
                        "resource_id": resource_id,
                        "chunk_index": row["chunk_index"],
                        "page_number": row["page_number"],
                        "content": row["content"],
                        "embedding": row["embedding"]
                    })
                supabase_admin.from_("document_chunks").delete().eq("resource_id", resource_id).execute()
                supabase_admin.from_("document_chunks").insert(reused_rows).execute()

                count = len(reused_rows)
                update_resource_status(resource_id, status="indexed", chunk_count=count, file_hash=file_hash)
                return ProcessDocumentResponse(
                    success=True,
                    resource_id=resource_id,
                    status="indexed",
                    chunk_count=count,
                    total_pages=0,
                    message="Document verified and indexed (reused matching version hash)."
                )

        # 4. Extract text page-by-page
        pages, metadata = extract_text_from_file(file_bytes, file_name)

        # 5. Chunk pages with precise page attribution
        chunks = chunk_pages(
            pages,
            chunk_size=settings.CHUNK_SIZE,
            chunk_overlap=settings.CHUNK_OVERLAP,
            max_chunks=settings.MAX_CHUNKS_PER_DOC
        )

        if not chunks:
            raise DocumentExtractionError("No valid text chunks could be produced from this document.")

        # 6. Generate embeddings for all chunks
        chunk_texts = [c["content"] for c in chunks]
        embeddings = generate_embeddings_batch(chunk_texts)

        # 7. Save chunks and vectors in PostgreSQL
        save_chunks_with_embeddings(student_id, resource_id, chunks, embeddings)

        # 8. Mark resource as indexed
        update_resource_status(
            resource_id,
            status="indexed",
            chunk_count=len(chunks),
            file_hash=file_hash
        )

        return ProcessDocumentResponse(
            success=True,
            resource_id=resource_id,
            status="indexed",
            chunk_count=len(chunks),
            total_pages=metadata.get("total_pages", len(pages)),
            message=f"Successfully indexed {len(chunks)} chunks across {metadata.get('total_pages', len(pages))} pages."
        )

    except ScannedPDFError as spe:
        update_resource_status(resource_id, status="scanned_image_no_text", error_msg=str(spe))
        return ProcessDocumentResponse(
            success=False,
            resource_id=resource_id,
            status="scanned_image_no_text",
            message=str(spe)
        )
    except Exception as e:
        error_msg = str(e)
        update_resource_status(resource_id, status="failed", error_msg=error_msg)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Document indexing failed: {error_msg}"
        )


@app.post("/api/ask", response_model=AskQuestionResponse)
def ask_question(
    request: AskQuestionRequest,
    current_student: dict = Depends(get_current_student)
):
    student_id = current_student["id"]
    question = request.question.strip()
    resource_id = request.resource_id

    doc_name = "All Uploaded Notes"

    # If asking about a specific document, verify ownership
    if resource_id:
        resource = get_student_resource(student_id, resource_id)
        if not resource:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Selected document was not found or access is denied."
            )
        if resource.get("processing_status") != "indexed":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Document '{resource.get('file_name')}' is not yet indexed. Status: {resource.get('processing_status')}"
            )
        doc_name = resource.get("file_name", "Document")

    # 1. Generate embedding for student's question
    query_vector = generate_embedding(question)

    # 2. Retrieve top matching chunks using pgvector similarity search
    # This executes match_document_chunks RPC with strict student_id isolation
    matching_chunks = search_similar_chunks(
        student_id=student_id,
        query_vector=query_vector,
        resource_id=resource_id,
        top_k=5,
        threshold=0.30
    )

    # 3. Generate a grounded answer using the retrieved passages
    try:
        result = generate_rag_answer(
            question=question,
            retrieved_chunks=matching_chunks,
            document_name=doc_name,
            chat_history=request.chat_history
        )
    except GeminiAPIError as e:
        raise HTTPException(
            status_code=e.status_code,
            detail=str(e),
        ) from e

    return AskQuestionResponse(
        success=True,
        answer=result["answer"],
        has_sufficient_evidence=result["has_sufficient_evidence"],
        citations=result["citations"],
        document_name=doc_name
    )


@app.post("/api/study/generate")
def generate_study_content(
    request: study_service.StudyGenerationRequest,
    current_student: dict = Depends(get_current_student)
):
    student_id = current_student["id"]
    source_map, context_parts = study_service.retrieve_study_sources(student_id, request)
    content = study_service.generate_questions(
        request,
        context_parts,
        {source["source_id"] for source in source_map},
    )
    study_set = study_service.persist_study_set(student_id, request, content, source_map)
    if request.kind == "flashcard":
        return {"study_set": study_set, "attempt": None, "questions": []}
    attempt_data = study_service.create_attempt(student_id, study_set["id"])
    return {"study_set": study_set, **attempt_data}


@app.get("/api/study/sets")
def get_study_sets(current_student: dict = Depends(get_current_student)):
    return {"study_sets": study_service.list_study_sets(current_student["id"])}


@app.get("/api/study/attempts")
def get_study_attempts(current_student: dict = Depends(get_current_student)):
    return {"attempts": study_service.list_attempts(current_student["id"])}


@app.post("/api/study/sets/{study_set_id}/attempts")
def start_study_attempt(
    study_set_id: str,
    current_student: dict = Depends(get_current_student)
):
    return study_service.create_attempt(current_student["id"], study_set_id)


@app.get("/api/study/attempts/{attempt_id}")
def resume_study_attempt(
    attempt_id: str,
    current_student: dict = Depends(get_current_student)
):
    return study_service.resume_attempt(current_student["id"], attempt_id)


@app.post("/api/study/attempts/{attempt_id}/answers")
def submit_study_answer(
    attempt_id: str,
    request: StudyAnswerRequest,
    current_student: dict = Depends(get_current_student)
):
    return study_service.submit_answer(
        current_student["id"],
        attempt_id,
        request.question_id,
        request.answer,
    )


@app.post("/api/study/attempts/{attempt_id}/practice")
def generate_missed_question_practice(
    attempt_id: str,
    request: StudyPracticeRequest,
    current_student: dict = Depends(get_current_student)
):
    return study_service.generate_missed_practice(
        current_student["id"],
        attempt_id,
        request.difficulty,
        request.count,
    )


@app.get("/api/study/sets/{study_set_id}/flashcards")
def get_study_flashcards(
    study_set_id: str,
    current_student: dict = Depends(get_current_student)
):
    return {"flashcards": study_service.get_flashcards(current_student["id"], study_set_id)}


@app.post("/api/study/sets/{study_set_id}/flashcards/{question_id}/reveal")
def reveal_study_flashcard(
    study_set_id: str,
    question_id: str,
    current_student: dict = Depends(get_current_student)
):
    return study_service.reveal_flashcard(current_student["id"], study_set_id, question_id)


@app.post("/api/study/sets/{study_set_id}/flashcards/{question_id}/review")
def mark_study_flashcard(
    study_set_id: str,
    question_id: str,
    request: FlashcardReviewRequest,
    current_student: dict = Depends(get_current_student)
):
    return study_service.mark_flashcard(
        current_student["id"],
        study_set_id,
        question_id,
        request.status,
    )
