from __future__ import annotations

import os
from typing import Any, Dict, List, Literal, Optional, Union

from fastapi import FastAPI, HTTPException, status, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, validator

try:  # Allow running both as package and module
    from storage import (
        create_highlight,
        create_session,
        get_document,
        get_or_create_document,
        get_session,
        get_session_export,
        record_search_episode,
        complete_session,
        record_interaction,
        save_document_summary,
        update_highlight_user_judgment,
        delete_highlight,
        save_pdf_review,
        _now_iso,
    )
except ModuleNotFoundError:  # pragma: no cover
    from .storage import (
        create_highlight,
        create_session,
        get_document,
        get_or_create_document,
        get_session,
        get_session_export,
        record_search_episode,
        complete_session,
        record_interaction,
        save_document_summary,
        update_highlight_user_judgment,
        delete_highlight,
        save_pdf_review,
        _now_iso,
    )

APP_NAME = "expert-annotator"
APP_VERSION = "0.3.0"

ALLOWED_LABELS = {
    "thumbsup",
    "thumbsdown",
    "neutral_information",
    "Core Concept",
    "Not Relevant",
    "Method Weakness",
    "Generate New Search",
    "Search Result",
    "PDF Highlight",
}

app = FastAPI(title=APP_NAME.replace("-", " ").title(), version=APP_VERSION)

allowed_origins = [
    "http://localhost",
    "http://127.0.0.1",
    "http://127.0.0.1:8000",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_origin_regex=r"chrome-extension://.*",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class HealthResponse(BaseModel):
    ok: bool
    service: str
    version: str


class SessionCreateRequest(BaseModel):
    expert_name: str
    topic: str
    research_goal: str


class SessionResponse(SessionCreateRequest):
    session_id: str
    start_time: str
    end_time: Optional[str]


class DocumentCreateRequest(BaseModel):
    title: str
    url: str
    type: Literal["html", "pdf"] = "html"
    accessed_at: str


class DocumentResponse(BaseModel):
    document_id: str
    title: str
    url: str
    type: str
    accessed_at: str
    global_judgment: Optional[Dict[str, Any]] = None
    pdf_review: Optional[Dict[str, Any]] = None


class TextQuoteSelector(BaseModel):
    type: Literal["TextQuote"] = "TextQuote"
    exact: str
    prefix: str = ""
    suffix: str = ""


class PDFTextSelector(BaseModel):
    type: Literal["PDFText"] = "PDFText"
    page: int = Field(..., ge=1)
    text: str
    coords: Optional[Dict[str, float]] = None

    @validator("coords")
    def validate_coords(cls, value: Optional[Dict[str, float]]) -> Optional[Dict[str, float]]:
        if value is None:
            return value
        required_keys = {"x1", "y1", "x2", "y2"}
        missing = required_keys - value.keys()
        if missing:
            raise ValueError(f"coords must include keys: {', '.join(sorted(required_keys))}")
        return value


class UserJudgment(BaseModel):
    chosen_label: str
    reasoning: Optional[str] = ""
    confidence: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    decision: Optional[str] = None
    decision_reason: Optional[str] = None
    decision_contribution: Optional[str] = None
    reading_contribution: Optional[str] = None

    @validator("chosen_label")
    def validate_label(cls, value: str) -> str:
        if value not in ALLOWED_LABELS:
            raise ValueError(
                f"chosen_label must be one of: {', '.join(sorted(ALLOWED_LABELS))}"
            )
        return value


SelectorType = Union[TextQuoteSelector, PDFTextSelector]


class HighlightCreateRequest(BaseModel):
    text: str
    selector: SelectorType
    ai_suggestions: List[str]
    user_judgment: UserJudgment
    context: Optional[str] = None


class HighlightResponse(BaseModel):
    highlight_id: str
    text: str
    context: Optional[str] = None
    selector: SelectorType
    ai_suggestions: List[str]
    user_judgment: UserJudgment
    timestamp: str


class AISuggestionsRequest(BaseModel):
    query: Optional[str] = None
    doc_meta: Optional[Dict[str, Any]] = None
    highlight_text: str


class AISuggestionsResponse(BaseModel):
    suggestions: List[str]


class SearchEpisodeBase(BaseModel):
    platform: Literal["google_scholar", "semantic_scholar"]
    query: str
    timestamp: str


class SearchEpisodeRequest(SearchEpisodeBase):
    pass


class SearchEpisodeResponse(SearchEpisodeBase):
    episode_id: str


class SessionCompleteResponse(BaseModel):
    ok: bool
    ended_at: str


class InteractionRequest(BaseModel):
    interaction_type: str
    payload: Dict[str, Any]
    timestamp: Optional[str] = None


class InteractionResponse(BaseModel):
    interaction_id: str
    interaction_type: str
    payload: Dict[str, Any]
    timestamp: str


class DocumentSummaryRequest(BaseModel):
    final_thoughts: str
    next_steps: Optional[str] = None


class DocumentSummaryResponse(BaseModel):
    document_id: str
    global_judgment: Dict[str, Any]


class PDFReviewRequest(BaseModel):
    sentiment: Literal["thumbsup", "thumbsdown", "neutral_information"]
    highlight_order: List[str] = Field(default_factory=list)


class PDFReviewResponse(PDFReviewRequest):
    document_id: str


class HighlightUpdateRequest(BaseModel):
    user_judgment: UserJudgment


class HighlightExport(BaseModel):
    highlight_id: str
    text: str
    context: Optional[str] = None
    selector: SelectorType
    ai_suggestions: List[str]
    user_judgment: UserJudgment
    timestamp: str


class DocumentExport(BaseModel):
    document_id: str
    title: str
    url: str
    type: str
    accessed_at: str
    highlights: List[HighlightExport]
    global_judgment: Optional[Dict[str, Any]] = None
    pdf_review: Optional[Dict[str, Any]] = None


class SessionExport(BaseModel):
    session_id: str
    expert_name: str
    topic: str
    research_goal: str
    start_time: str
    end_time: Optional[str]
    documents: List[DocumentExport]
    search_episodes: List[SearchEpisodeBase] = Field(default_factory=list)
    interactions: List[Dict[str, Any]] = Field(default_factory=list)


def _generate_mock_suggestions(highlight_text: str) -> List[str]:
    snippet = highlight_text.strip().replace("\n", " ")
    truncated = snippet[:120] + ("…" if len(snippet) > 120 else "")
    return [
        f"Assess how this passage advances the research goal: \"{truncated}\"",
        "Identify assumptions or evidence gaps that need validation.",
        "Consider follow-up searches to deepen context or cross-check sources.",
    ]


def _parse_selector(data: Dict[str, Any]) -> SelectorType:
    selector_type = data.get("type")
    if selector_type == "PDFText":
        return PDFTextSelector(**data)
    return TextQuoteSelector(**data)


AI_FORWARD_URL = os.getenv("AI_API_URL")


@app.get("/healthz", response_model=HealthResponse)
async def healthz() -> HealthResponse:
    """Basic liveness probe to verify the service is up."""
    return HealthResponse(ok=True, service=APP_NAME, version=APP_VERSION)


@app.post("/sessions", response_model=SessionResponse, status_code=status.HTTP_201_CREATED)
async def create_session_endpoint(payload: SessionCreateRequest) -> SessionResponse:
    session = create_session(
        expert_name=payload.expert_name,
        topic=payload.topic,
        research_goal=payload.research_goal,
    )
    return SessionResponse(**session)


@app.post(
    "/sessions/{session_id}/documents",
    response_model=DocumentResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_document_endpoint(
    session_id: str, payload: DocumentCreateRequest
) -> DocumentResponse:
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")

    document = get_or_create_document(
        session_id=session_id,
        title=payload.title,
        url=payload.url,
        doc_type=payload.type,
        accessed_at=payload.accessed_at,
    )
    return DocumentResponse(**document)


@app.post(
    "/sessions/{session_id}/documents/{document_id}/highlights",
    response_model=HighlightResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_highlight_endpoint(
    session_id: str,
    document_id: str,
    payload: HighlightCreateRequest,
) -> HighlightResponse:
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")

    document = get_document(document_id)
    if not document or document["session_id"] != session_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")

    highlight = create_highlight(
        session_id=session_id,
        document_id=document_id,
        text=payload.text,
        selector=payload.selector.dict(),
        ai_suggestions=payload.ai_suggestions,
        user_judgment=payload.user_judgment.dict(exclude_none=True),
        context=payload.context,
    )
    return HighlightResponse(
        highlight_id=highlight["highlight_id"],
        text=highlight["text"],
        context=highlight.get("context"),
        selector=_parse_selector(highlight["selector"]),
        ai_suggestions=highlight["ai_suggestions"],
        user_judgment=UserJudgment(**highlight["user_judgment"]),
        timestamp=highlight["timestamp"],
    )


@app.post("/ai/suggestions", response_model=AISuggestionsResponse)
async def ai_suggestions_endpoint(payload: AISuggestionsRequest) -> AISuggestionsResponse:
    if AI_FORWARD_URL:
        import httpx

        async with httpx.AsyncClient() as client:
            response = await client.post(
                AI_FORWARD_URL,
                json={
                    "highlight_text": payload.highlight_text,
                    "query": payload.query,
                    "doc_meta": payload.doc_meta,
                },
                timeout=30,
            )
            response.raise_for_status()
            data = response.json()
        suggestions = data.get("suggestions") or []
        if not suggestions:
            suggestions = _generate_mock_suggestions(payload.highlight_text)
    else:
        suggestions = _generate_mock_suggestions(payload.highlight_text)
    return AISuggestionsResponse(suggestions=suggestions)


@app.post(
    "/sessions/{session_id}/search-episodes",
    response_model=SearchEpisodeResponse,
    status_code=status.HTTP_201_CREATED,
)
async def record_search_episode_endpoint(
    session_id: str, payload: SearchEpisodeRequest
) -> SearchEpisodeResponse:
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")

    episode = record_search_episode(
        session_id=session_id,
        platform=payload.platform,
        query=payload.query,
        timestamp=payload.timestamp,
    )
    return SearchEpisodeResponse(**episode)


@app.post(
    "/sessions/{session_id}/complete",
    response_model=SessionCompleteResponse,
)
async def complete_session_endpoint(session_id: str) -> SessionCompleteResponse:
    ended_at = complete_session(session_id)
    if not ended_at:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")
    return SessionCompleteResponse(ok=True, ended_at=ended_at)


@app.post(
    "/sessions/{session_id}/interactions",
    response_model=InteractionResponse,
    status_code=status.HTTP_201_CREATED,
)
async def record_interaction_endpoint(
    session_id: str, payload: InteractionRequest
) -> InteractionResponse:
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")

    interaction = record_interaction(
        session_id=session_id,
        interaction_type=payload.interaction_type,
        payload=payload.payload,
        timestamp=payload.timestamp,
    )
    return InteractionResponse(
        interaction_id=interaction["interaction_id"],
        interaction_type=interaction["interaction_type"],
        payload=interaction["payload"],
        timestamp=interaction["timestamp"],
    )


@app.post(
    "/sessions/{session_id}/documents/{document_id}/summary",
    response_model=DocumentSummaryResponse,
)
async def save_document_summary_endpoint(
    session_id: str,
    document_id: str,
    payload: DocumentSummaryRequest,
) -> DocumentSummaryResponse:
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")

    document = get_document(document_id)
    if not document or document["session_id"] != session_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")

    summary_payload = {
        "final_thoughts": payload.final_thoughts,
        "next_steps": payload.next_steps,
        "timestamp": _now_iso(),
    }
    updated = save_document_summary(session_id=session_id, document_id=document_id, summary=summary_payload)
    if not updated:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Unable to save summary")

    return DocumentSummaryResponse(
        document_id=document_id,
        global_judgment=summary_payload,
    )


@app.patch(
    "/highlights/{highlight_id}",
    response_model=HighlightResponse,
)
async def update_highlight_endpoint(highlight_id: str, payload: HighlightUpdateRequest) -> HighlightResponse:
    updated = update_highlight_user_judgment(highlight_id, payload.user_judgment.dict(exclude_none=True))
    if not updated:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Highlight not found")
    return HighlightResponse(
        highlight_id=updated["highlight_id"],
        text=updated["text"],
        context=updated.get("context"),
        selector=_parse_selector(updated["selector"]),
        ai_suggestions=updated["ai_suggestions"],
        user_judgment=UserJudgment(**updated["user_judgment"]),
        timestamp=updated["timestamp"],
    )


@app.post(
    "/sessions/{session_id}/documents/{document_id}/pdf-review",
    response_model=PDFReviewResponse,
    status_code=status.HTTP_200_OK,
)
async def save_pdf_review_endpoint(
    session_id: str,
    document_id: str,
    payload: PDFReviewRequest,
) -> PDFReviewResponse:
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")

    document = get_document(document_id)
    if not document or document.get("session_id") != session_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")

    if document.get("type") != "pdf":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Reviews only supported for PDF documents")

    review_payload = {
        "sentiment": payload.sentiment,
        "highlight_order": payload.highlight_order,
    }
    saved = save_pdf_review(session_id=session_id, document_id=document_id, review=review_payload)
    if not saved:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Unable to save PDF review")
    return PDFReviewResponse(document_id=document_id, **review_payload)


@app.delete(
    "/highlights/{highlight_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_highlight_endpoint(highlight_id: str) -> Response:
    deleted = delete_highlight(highlight_id)
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Highlight not found")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@app.get("/export/{session_id}", response_model=SessionExport)
async def export_session(session_id: str) -> SessionExport:
    export_payload = get_session_export(session_id)
    if not export_payload:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")

    documents_payload = []
    for document in export_payload["documents"]:
        highlights_payload = [
            HighlightExport(
                highlight_id=hl["highlight_id"],
                text=hl["text"],
                context=hl.get("context"),
                selector=_parse_selector(hl["selector"]),
                ai_suggestions=hl["ai_suggestions"],
                user_judgment=UserJudgment(**hl["user_judgment"]),
                timestamp=hl["timestamp"],
            )
            for hl in document["highlights"]
        ]
        documents_payload.append(
            DocumentExport(
                document_id=document["document_id"],
                title=document["title"],
                url=document["url"],
                type=document["type"],
                accessed_at=document["accessed_at"],
                highlights=highlights_payload,
                global_judgment=document["global_judgment"],
                pdf_review=document.get("pdf_review"),
            )
        )

    return SessionExport(
        session_id=export_payload["session_id"],
        expert_name=export_payload["expert_name"],
        topic=export_payload["topic"],
        research_goal=export_payload["research_goal"],
        start_time=export_payload["start_time"],
        end_time=export_payload["end_time"],
        documents=documents_payload,
        search_episodes=[SearchEpisodeBase(**episode) for episode in export_payload["search_episodes"]],
        interactions=export_payload["interactions"],
    )
