from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from .database import get_connection


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def create_session(expert_name: str, topic: str, research_goal: str) -> Dict[str, Any]:
    session_id = str(uuid.uuid4())
    start_time = _now_iso()
    with get_connection() as conn:
        conn.execute(
            """
            INSERT INTO sessions (session_id, expert_name, topic, research_goal, start_time, end_time)
            VALUES (?, ?, ?, ?, ?, NULL)
            """,
            (session_id, expert_name, topic, research_goal, start_time),
        )
    return {
        "session_id": session_id,
        "expert_name": expert_name,
        "topic": topic,
        "research_goal": research_goal,
        "start_time": start_time,
        "end_time": None,
    }


def get_session(session_id: str) -> Optional[Dict[str, Any]]:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT * FROM sessions WHERE session_id = ?", (session_id,)
        ).fetchone()
    if not row:
        return None
    return dict(row)


def get_or_create_document(
    session_id: str,
    title: str,
    url: str,
    doc_type: str,
    accessed_at: str,
) -> Dict[str, Any]:
    document_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"{session_id}:{url}"))
    with get_connection() as conn:
        conn.execute(
            """
            INSERT OR IGNORE INTO documents (document_id, session_id, title, url, type, accessed_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (document_id, session_id, title, url, doc_type, accessed_at),
        )
        row = conn.execute(
            "SELECT * FROM documents WHERE document_id = ?", (document_id,)
        ).fetchone()
    return dict(row)


def get_document(document_id: str) -> Optional[Dict[str, Any]]:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT * FROM documents WHERE document_id = ?", (document_id,)
        ).fetchone()
    if not row:
        return None
    return dict(row)


def create_highlight(
    session_id: str,
    document_id: str,
    text: str,
    selector: Dict[str, Any],
    ai_suggestions: List[str],
    chosen_label: str,
    reasoning: str,
    confidence: Optional[float] = None,
) -> Dict[str, Any]:
    highlight_id = str(uuid.uuid4())
    timestamp = _now_iso()
    with get_connection() as conn:
        conn.execute(
            """
            INSERT INTO highlights (
                highlight_id,
                session_id,
                document_id,
                text,
                selector_json,
                ai_suggestions_json,
                chosen_label,
                reasoning,
                confidence,
                timestamp
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                highlight_id,
                session_id,
                document_id,
                text,
                json.dumps(selector),
                json.dumps(ai_suggestions),
                chosen_label,
                reasoning,
                confidence,
                timestamp,
            ),
        )
    return {
        "highlight_id": highlight_id,
        "session_id": session_id,
        "document_id": document_id,
        "text": text,
        "selector": selector,
        "ai_suggestions": ai_suggestions,
        "user_judgment": {
            "chosen_label": chosen_label,
            "reasoning": reasoning,
            "confidence": confidence,
        },
        "timestamp": timestamp,
    }


def get_session_export(session_id: str) -> Optional[Dict[str, Any]]:
    with get_connection() as conn:
        session_row = conn.execute(
            "SELECT * FROM sessions WHERE session_id = ?", (session_id,)
        ).fetchone()
        if not session_row:
            return None

        document_rows = conn.execute(
            "SELECT * FROM documents WHERE session_id = ? ORDER BY accessed_at",
            (session_id,),
        ).fetchall()

        documents: List[Dict[str, Any]] = []
        for doc_row in document_rows:
            highlight_rows = conn.execute(
                "SELECT * FROM highlights WHERE document_id = ? ORDER BY timestamp",
                (doc_row["document_id"],),
            ).fetchall()

            highlights = []
            for hl_row in highlight_rows:
                highlights.append(
                    {
                        "highlight_id": hl_row["highlight_id"],
                        "text": hl_row["text"],
                        "selector": json.loads(hl_row["selector_json"]),
                        "ai_suggestions": json.loads(hl_row["ai_suggestions_json"]),
                        "user_judgment": {
                            "chosen_label": hl_row["chosen_label"],
                            "reasoning": hl_row["reasoning"],
                            "confidence": hl_row["confidence"],
                        },
                        "timestamp": hl_row["timestamp"],
                    }
                )

            documents.append(
                {
                    "document_id": doc_row["document_id"],
                    "title": doc_row["title"],
                    "url": doc_row["url"],
                    "type": doc_row["type"],
                    "accessed_at": doc_row["accessed_at"],
                    "highlights": highlights,
                    "global_judgment": None,
                }
            )

    return {
        "session_id": session_row["session_id"],
        "expert_name": session_row["expert_name"],
        "topic": session_row["topic"],
        "research_goal": session_row["research_goal"],
        "start_time": session_row["start_time"],
        "end_time": session_row["end_time"],
        "documents": documents,
        "search_episodes": [],
    }
