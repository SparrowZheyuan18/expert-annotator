from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional, Union

from fastapi import FastAPI, HTTPException, status
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
    )
except ModuleNotFoundError:  # pragma: no cover
    from .storage import (
        create_highlight,
        create_session,
        get_document,
        get_or_create_document,
        get_session,
        get_session_export,
    )

APP_NAME = "expert-annotator"
APP_VERSION = "0.2.0"

ALLOWED_LABELS = {
    "Core Concept",
    "Not Relevant",
    "Method Weakness",
    "Generate New Search",
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
    type: str = Field("html", description="Document type, defaults to 'html'")
    accessed_at: str


class DocumentResponse(BaseModel):
    document_id: str
    title: str
    url: str
    type: str
    accessed_at: str


class TextQuoteSelector(BaseModel):
    type: Literal["TextQuote"] = "TextQuote"
    exact: str
    prefix: str = ""
    suffix: str = ""


class UserJudgment(BaseModel):
    chosen_label: str
    reasoning: str
    confidence: Optional[float] = Field(default=None, ge=0.0, le=1.0)

    @validator("chosen_label")
    def validate_label(cls, value: str) -> str:
        if value not in ALLOWED_LABELS:
            raise ValueError(
                f"chosen_label must be one of: {', '.join(sorted(ALLOWED_LABELS))}"
            )
        return value


class HighlightCreateRequest(BaseModel):
    text: str
    selector: TextQuoteSelector
    ai_suggestions: List[str]
    user_judgment: UserJudgment


class HighlightResponse(BaseModel):
    highlight_id: str
    text: str
    selector: TextQuoteSelector
    ai_suggestions: List[str]
    user_judgment: UserJudgment
    timestamp: str


class AISuggestionsRequest(BaseModel):
    query: Optional[str] = None
    doc_meta: Optional[Dict[str, Any]] = None
    highlight_text: str


class AISuggestionsResponse(BaseModel):
    suggestions: List[str]


class HighlightExport(BaseModel):
    highlight_id: str
    text: str
    selector: TextQuoteSelector
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


class SessionExport(BaseModel):
    session_id: str
    expert_name: str
    topic: str
    research_goal: str
    start_time: str
    end_time: Optional[str]
    documents: List[DocumentExport]
    search_episodes: List[Any] = Field(default_factory=list)


def _generate_mock_suggestions(highlight_text: str) -> List[str]:
    snippet = highlight_text.strip().replace("\n", " ")
    truncated = snippet[:120] + ("…" if len(snippet) > 120 else "")
    return [
        f"Assess how this passage advances the research goal: \"{truncated}\"",
        "Identify assumptions or evidence gaps that need validation.",
        "Consider follow-up searches to deepen context or cross-check sources.",
    ]


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
        chosen_label=payload.user_judgment.chosen_label,
        reasoning=payload.user_judgment.reasoning,
        confidence=payload.user_judgment.confidence,
    )
    return HighlightResponse(
        highlight_id=highlight["highlight_id"],
        text=highlight["text"],
        selector=TextQuoteSelector(**highlight["selector"]),
        ai_suggestions=highlight["ai_suggestions"],
        user_judgment=UserJudgment(**highlight["user_judgment"]),
        timestamp=highlight["timestamp"],
    )


@app.post("/ai/suggestions", response_model=AISuggestionsResponse)
async def ai_suggestions_endpoint(payload: AISuggestionsRequest) -> AISuggestionsResponse:
    suggestions = _generate_mock_suggestions(payload.highlight_text)
    return AISuggestionsResponse(suggestions=suggestions)


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
                selector=TextQuoteSelector(**hl["selector"]),
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
        search_episodes=export_payload["search_episodes"],
    )
