from __future__ import annotations

import json
import logging
import os
import re
from typing import Any, Dict, List, Literal, Optional, Union
from urllib.parse import urlparse

import httpx
import litellm
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, status, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, validator

load_dotenv()

logger = logging.getLogger(__name__)

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
    ai_suggestions: List["AISuggestionItem"] = Field(default_factory=list)
    user_judgment: UserJudgment
    context: Optional[str] = None


class HighlightResponse(BaseModel):
    highlight_id: str
    text: str
    context: Optional[str] = None
    selector: SelectorType
    ai_suggestions: List["AISuggestionItem"] = Field(default_factory=list)
    user_judgment: UserJudgment
    timestamp: str


class AISuggestionItem(BaseModel):
    title: str
    detail: str


class AISuggestionsRequest(BaseModel):
    query: Optional[str] = None
    doc_meta: Optional[Dict[str, Any]] = None
    highlight_text: str
    context: Optional[str] = None
    document_text: Optional[str] = None
    label: Optional[str] = None
    mode: Optional[str] = None


class AISuggestionsResponse(BaseModel):
    suggestions: List[AISuggestionItem]


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
    ai_suggestions: List[AISuggestionItem] = Field(default_factory=list)
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




def _make_suggestion(title: str, detail: str, fallback_title: str = "Insight") -> Optional[AISuggestionItem]:
    cleaned_detail = _clean_text(detail)
    if not cleaned_detail:
        return None
    cleaned_title = _clean_text(title) or fallback_title
    return AISuggestionItem(title=cleaned_title[:80], detail=cleaned_detail[:320])


def _generate_mock_suggestions(highlight_text: str) -> List[AISuggestionItem]:
    snippet = highlight_text.strip().replace("\n", " ")
    truncated = snippet[:120] + ("…" if len(snippet) > 120 else "")
    mock_entries = [
        ("Connect to goal", f"Assess how this passage advances the research goal: \"{truncated}\""),
        ("Interrogate assumptions", "Identify assumptions or evidence gaps that need validation."),
        ("Plan next read", "Consider follow-up searches to deepen context or cross-check sources."),
    ]
    suggestions: List[AISuggestionItem] = []
    for title, detail in mock_entries:
        suggestion = _make_suggestion(title, detail)
        if suggestion:
            suggestions.append(suggestion)
    return suggestions[:AI_SUGGESTION_COUNT]


def _parse_selector(data: Dict[str, Any]) -> SelectorType:
    selector_type = data.get("type")
    if selector_type == "PDFText":
        return PDFTextSelector(**data)
    return TextQuoteSelector(**data)


AI_FORWARD_URL = os.getenv("AI_API_URL")
PROVIDER_WINE = "wine"
PROVIDER_OPENAI = "openai"
AI_PROVIDER = os.getenv("AI_PROVIDER", PROVIDER_WINE).strip().lower()
if AI_PROVIDER not in {PROVIDER_WINE, PROVIDER_OPENAI}:
    AI_PROVIDER = PROVIDER_WINE

def _normalize_model_name(raw_model: Optional[str], *, default: str) -> str:
    model = raw_model or default
    if not model.startswith("openai/"):
        model = f"openai/{model}"
    return model

WINE_API_KEY = os.getenv("WINE_API_KEY")
WINE_API_BASE_URL = os.getenv("WINE_API_BASE_URL") or "https://ai-gateway.andrew.cmu.edu/"
WINE_LLM_MODEL = _normalize_model_name(os.getenv("WINE_LLM_MODEL"), default="wine-gemini-2.5-flash")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
OPENAI_API_BASE_URL = os.getenv("OPENAI_API_BASE_URL") or "https://api.openai.com/v1"
OPENAI_LLM_MODEL = _normalize_model_name(os.getenv("OPENAI_MODEL"), default="gpt-4.1")
try:
    AI_SUGGESTION_COUNT = max(1, int(os.getenv("AI_SUGGESTION_COUNT", "3")))
except ValueError:
    AI_SUGGESTION_COUNT = 3
try:
    AI_REQUEST_TIMEOUT = float(os.getenv("AI_REQUEST_TIMEOUT", "30"))
except ValueError:
    AI_REQUEST_TIMEOUT = 30.0

DEFAULT_SUGGESTION_SYSTEM_PROMPT = (
    "You are the expert's inner monologue during a deep-research annotation workflow. "
    "Use the provided user label (thumbsup, thumbsdown, etc.) to decide whether you plan to lean in or walk away, "
    "and speak in the first person to defend that instinct. "
    f"Return JSON ONLY: an array containing exactly {AI_SUGGESTION_COUNT} objects. "
    "Each object must include `title` (<=5 words, short theme) and `detail` (<=35 words, first-person rationale). "
    "Do not add numbering, bullets, or commentary outside the JSON array."
)


def _extract_site_from_meta(doc_meta: Dict[str, Any]) -> Optional[str]:
    site = doc_meta.get("site")
    if site:
        return site
    url = doc_meta.get("url")
    if not url:
        return None
    try:
        parsed = urlparse(url)
    except ValueError:
        return None
    return parsed.hostname


def _normalise_mode(payload: AISuggestionsRequest) -> str:
    doc_meta = payload.doc_meta or {}
    raw_mode = payload.mode or doc_meta.get("type")
    if isinstance(raw_mode, str):
        lowered = raw_mode.lower()
        if lowered in {"html", "pdf"}:
            return lowered
    return "html"


def _clean_text(value: Optional[str]) -> str:
    if not value:
        return ""
    return re.sub(r"\s+", " ", value).strip()


def _build_highlight_prompt(payload: AISuggestionsRequest) -> str:
    doc_meta = payload.doc_meta or {}
    mode = _normalise_mode(payload)
    site = _extract_site_from_meta(doc_meta) or "unknown"
    title = doc_meta.get("title") or "Untitled document"
    url = doc_meta.get("url") or "N/A"
    label = payload.label or doc_meta.get("label") or doc_meta.get("sentiment") or "unspecified"
    highlight = _clean_text(payload.highlight_text)
    context = _clean_text(payload.context)
    document_text = _clean_text(payload.document_text)
    query = _clean_text(payload.query)

    if mode == "pdf":
        scenario = (
            "You are already reading the PDF in depth. Offer concise reviewer-style comments about the passage, "
            "covering how it affects understanding of the paper's claims, methods, or open questions."
        )
    else:
        scenario = (
            "You are triaging web/search results during deep research. Explain why you would or would not keep reading "
            "this paper, referencing author credibility, topic alignment, novelty, or gaps."
        )

    voice = (
        'Use a first-person voice such as "I want to read this because..." or '
        '"I might skip this because...". Each statement should feel like an expert thinking aloud.'
    )

    sections = [
        f"Mode: {mode.upper()}",
        f"Site: {site}",
        f"Document title: {title}",
        f"Document URL: {url}",
        f"User label: {label}",
        "Focus guidance:\nGround each insight directly in the highlighted snippet; use the provided context only to clarify or extend that reasoning.",
        f"Scenario guidance:\n{scenario}",
        f"Voice guidance:\n{voice}",
        f"Highlighted passage:\n{highlight}",
    ]
    if context:
        sections.append(f"Local context:\n{context}")
    if mode == "pdf" and document_text:
        sections.append(f"Full document text:\n{document_text}")
    elif document_text:
        sections.append(f"Additional document text:\n{document_text}")
    if query:
        sections.append(f"Active search query: {query}")
    return "\n\n".join(sections)


def _extract_suggestions_from_content(content: str) -> List[AISuggestionItem]:
    raw = content.strip()
    if not raw:
        return []

    def _strip_first_code_fence(value: str) -> str:
        fence_pattern = re.compile(r"```(?:[\w+-]+)?\s*(.*?)\s*```", re.S)
        match = fence_pattern.search(value)
        if match:
            return match.group(1).strip()
        return value

    def _extract_json_fragment(value: str) -> Optional[Any]:
        decoder = json.JSONDecoder()
        for match in re.finditer(r"[\{\[]", value):
            try:
                fragment, _ = decoder.raw_decode(value[match.start():])
                return fragment
            except json.JSONDecodeError:
                continue
        return None

    def _try_parse(candidate: str) -> Optional[List[AISuggestionItem]]:
        try:
            parsed = json.loads(candidate)
            normalized = _normalize_suggestion_entries(parsed)
            if normalized:
                return normalized
        except json.JSONDecodeError:
            fragment = _extract_json_fragment(candidate)
            if fragment is not None:
                normalized = _normalize_suggestion_entries(fragment)
                if normalized:
                    return normalized
        return None

    stripped = _strip_first_code_fence(raw)
    for candidate in [stripped, raw]:
        normalized = _try_parse(candidate)
        if normalized:
            return normalized
    lines = raw.splitlines()
    suggestions: List[AISuggestionItem] = []
    fallback_index = 0
    for raw_line in lines:
        cleaned = re.sub(r"^[\-\*\d\)\.\s]+", "", raw_line).strip()
        if not cleaned:
            continue
        suggestion = _parse_suggestion_line(cleaned, fallback_index)
        if suggestion:
            suggestions.append(suggestion)
            fallback_index += 1
        if len(suggestions) >= AI_SUGGESTION_COUNT:
            break
    if not suggestions:
        fallback = _make_suggestion("Key insight", raw)
        if fallback:
            suggestions.append(fallback)
    return suggestions[:AI_SUGGESTION_COUNT]


def _parse_suggestion_line(text: str, index: int) -> Optional[AISuggestionItem]:
    separators = ("::", "—", " - ", ":", "-")
    for separator in separators:
        if separator in text:
            title, detail = text.split(separator, 1)
            return _make_suggestion(title, detail, fallback_title=f"Idea {index + 1}")
    return _make_suggestion(f"Idea {index + 1}", text, fallback_title=f"Idea {index + 1}")


def _normalize_suggestion_entries(raw: Any) -> List[AISuggestionItem]:
    if not raw:
        return []
    entries = raw
    if isinstance(entries, dict):
        entries = [entries]
    if isinstance(entries, str):
        return _extract_suggestions_from_content(entries)
    suggestions: List[AISuggestionItem] = []
    if not isinstance(entries, list):
        return suggestions
    for idx, entry in enumerate(entries):
        if isinstance(entry, AISuggestionItem):
            suggestions.append(entry)
        elif isinstance(entry, dict):
            candidate = _make_suggestion(
                entry.get("title") or entry.get("heading") or entry.get("label") or f"Idea {idx + 1}",
                entry.get("detail") or entry.get("text") or entry.get("body") or entry.get("description") or "",
                fallback_title=f"Idea {idx + 1}",
            )
            if candidate:
                suggestions.append(candidate)
        elif isinstance(entry, str):
            line_suggestions = _extract_suggestions_from_content(entry)
            suggestions.extend(line_suggestions)
        if len(suggestions) >= AI_SUGGESTION_COUNT:
            break
    return suggestions[:AI_SUGGESTION_COUNT]


async def _forward_suggestions(payload: AISuggestionsRequest) -> List[AISuggestionItem]:
    if not AI_FORWARD_URL:
        return []
    try:
        async with httpx.AsyncClient(timeout=AI_REQUEST_TIMEOUT) as client:
            response = await client.post(
                AI_FORWARD_URL,
                json={
                    "highlight_text": payload.highlight_text,
                    "query": payload.query,
                    "doc_meta": payload.doc_meta,
                    "context": payload.context,
                    "document_text": payload.document_text,
                    "label": payload.label,
                    "mode": payload.mode,
                },
            )
            response.raise_for_status()
    except httpx.HTTPError as exc:
        logger.warning("AI forward request failed: %s", exc)
        return []
    data = response.json()
    return _normalize_suggestion_entries(data.get("suggestions"))


async def _request_litellm_suggestions(
    *,
    api_key: Optional[str],
    base_url: str,
    model: str,
    payload: AISuggestionsRequest,
    provider_label: str,
) -> List[AISuggestionItem]:
    if not api_key:
        return []
    user_prompt = _build_highlight_prompt(payload)
    messages = [
        {"role": "system", "content": DEFAULT_SUGGESTION_SYSTEM_PROMPT},
        {
            "role": "user",
            "content": (
                f"Provide {AI_SUGGESTION_COUNT} concrete next actions.\n\n{user_prompt}"
            ),
        },
    ]
    # print(
    #     f"[AI] {provider_label} request | model={model} temp=0.4 | messages={messages}"
    # )
    try:
        response = await litellm.acompletion(
            api_key=api_key,
            base_url=base_url,
            model=model,
            messages=messages,
            temperature=0.4,
            max_tokens=4096,
            n=1,
            timeout=AI_REQUEST_TIMEOUT,
        )
    except Exception as exc:  # litellm raises rich exceptions, but keep generic fallback
        logger.warning("%s suggestion request failed: %s", provider_label, exc)
        return []
    payload_json = response
    # print(f"[AI] {provider_label} raw response: {payload_json}")
    choices = payload_json.get("choices") or []
    for choice in choices:
        message = choice.get("message") or {}
        content = message.get("content")
        if content:
            suggestions = _extract_suggestions_from_content(content)
            if suggestions:
                return suggestions
    return []


async def _request_wine_suggestions(payload: AISuggestionsRequest) -> List[AISuggestionItem]:
    return await _request_litellm_suggestions(
        api_key=WINE_API_KEY,
        base_url=WINE_API_BASE_URL,
        model=WINE_LLM_MODEL,
        payload=payload,
        provider_label="LiteLLM/WINE",
    )


async def _request_openai_suggestions(payload: AISuggestionsRequest) -> List[AISuggestionItem]:
    return await _request_litellm_suggestions(
        api_key=OPENAI_API_KEY,
        base_url=OPENAI_API_BASE_URL,
        model=OPENAI_LLM_MODEL,
        payload=payload,
        provider_label="LiteLLM/OpenAI",
    )


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
        ai_suggestions=[item.dict() for item in payload.ai_suggestions],
        user_judgment=payload.user_judgment.dict(exclude_none=True),
        context=payload.context,
    )
    suggestion_items = _normalize_suggestion_entries(highlight["ai_suggestions"])
    return HighlightResponse(
        highlight_id=highlight["highlight_id"],
        text=highlight["text"],
        context=highlight.get("context"),
        selector=_parse_selector(highlight["selector"]),
        ai_suggestions=suggestion_items,
        user_judgment=UserJudgment(**highlight["user_judgment"]),
        timestamp=highlight["timestamp"],
    )


@app.post("/ai/suggestions", response_model=AISuggestionsResponse)
async def ai_suggestions_endpoint(payload: AISuggestionsRequest) -> AISuggestionsResponse:
    suggestions: List[AISuggestionItem] = []
    if AI_FORWARD_URL:
        suggestions = await _forward_suggestions(payload)
    if not suggestions:
        if AI_PROVIDER == PROVIDER_WINE:
            suggestions = await _request_wine_suggestions(payload)
        elif AI_PROVIDER == PROVIDER_OPENAI:
            suggestions = await _request_openai_suggestions(payload)
    if not suggestions:
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
    suggestion_items = _normalize_suggestion_entries(updated["ai_suggestions"])
    return HighlightResponse(
        highlight_id=updated["highlight_id"],
        text=updated["text"],
        context=updated.get("context"),
        selector=_parse_selector(updated["selector"]),
        ai_suggestions=suggestion_items,
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
                ai_suggestions=_normalize_suggestion_entries(hl["ai_suggestions"]),
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
