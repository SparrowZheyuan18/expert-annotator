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
    document = dict(row)
    if document.get("global_judgment_json"):
        document["global_judgment"] = json.loads(document["global_judgment_json"])
    else:
        document["global_judgment"] = None
    document.pop("global_judgment_json", None)
    if document.get("pdf_review_json"):
        document["pdf_review"] = json.loads(document["pdf_review_json"])
    else:
        document["pdf_review"] = None
    document.pop("pdf_review_json", None)
    return document


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
    document = dict(row)
    if document.get("global_judgment_json"):
        document["global_judgment"] = json.loads(document["global_judgment_json"])
    else:
        document["global_judgment"] = None
    document.pop("global_judgment_json", None)
    if document.get("pdf_review_json"):
        document["pdf_review"] = json.loads(document["pdf_review_json"])
    else:
        document["pdf_review"] = None
    document.pop("pdf_review_json", None)
    return document


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
    user_judgment: Dict[str, Any],
    context: Optional[str] = None,
) -> Dict[str, Any]:
    highlight_id = str(uuid.uuid4())
    timestamp = _now_iso()
    chosen_label = user_judgment.get("chosen_label", "")
    reasoning = user_judgment.get("reasoning", "")
    confidence = user_judgment.get("confidence")
    user_judgment_json = json.dumps(user_judgment)
    with get_connection() as conn:
        conn.execute(
            """
            INSERT INTO highlights (
                highlight_id,
                session_id,
                document_id,
                text,
                context,
                selector_json,
                ai_suggestions_json,
                chosen_label,
                reasoning,
                confidence,
                user_judgment_json,
                timestamp
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                highlight_id,
                session_id,
                document_id,
                text,
                context,
                json.dumps(selector),
                json.dumps(ai_suggestions),
                chosen_label,
                reasoning,
                confidence,
                user_judgment_json,
                timestamp,
            ),
        )
    return {
        "highlight_id": highlight_id,
        "session_id": session_id,
        "document_id": document_id,
        "text": text,
        "context": context,
        "selector": selector,
        "ai_suggestions": ai_suggestions,
        "user_judgment": user_judgment,
        "timestamp": timestamp,
    }


def delete_highlight(highlight_id: str) -> bool:
    with get_connection() as conn:
        result = conn.execute(
            "DELETE FROM highlights WHERE highlight_id = ?",
            (highlight_id,),
        )
    return result.rowcount > 0


def record_search_episode(session_id: str, platform: str, query: str, timestamp: str) -> Dict[str, Any]:
    episode_id = str(uuid.uuid4())
    with get_connection() as conn:
        conn.execute(
            """
            INSERT INTO search_episodes (episode_id, session_id, platform, query, timestamp)
            VALUES (?, ?, ?, ?, ?)
            """,
            (episode_id, session_id, platform, query, timestamp),
        )
    return {
        "episode_id": episode_id,
        "session_id": session_id,
        "platform": platform,
        "query": query,
        "timestamp": timestamp,
    }


def complete_session(session_id: str) -> Optional[str]:
    ended_at = _now_iso()
    with get_connection() as conn:
        result = conn.execute(
            """
            UPDATE sessions
            SET end_time = ?
            WHERE session_id = ?
            """,
            (ended_at, session_id),
        )
    if result.rowcount == 0:
        return None
    return ended_at


def record_interaction(
    session_id: str,
    interaction_type: str,
    payload: Dict[str, Any],
    timestamp: Optional[str] = None,
) -> Dict[str, Any]:
    interaction_id = str(uuid.uuid4())
    ts = timestamp or _now_iso()
    with get_connection() as conn:
        conn.execute(
            """
            INSERT INTO interactions (interaction_id, session_id, interaction_type, payload_json, timestamp)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                interaction_id,
                session_id,
                interaction_type,
                json.dumps(payload),
                ts,
            ),
        )
    return {
        "interaction_id": interaction_id,
        "session_id": session_id,
        "interaction_type": interaction_type,
        "payload": payload,
        "timestamp": ts,
    }


def save_document_summary(
    session_id: str,
    document_id: str,
    summary: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    with get_connection() as conn:
        result = conn.execute(
            """
            UPDATE documents
            SET global_judgment_json = ?
            WHERE document_id = ? AND session_id = ?
            """,
            (json.dumps(summary), document_id, session_id),
        )
        if result.rowcount == 0:
            return None
        row = conn.execute(
            "SELECT * FROM documents WHERE document_id = ?",
            (document_id,),
        ).fetchone()
    document = dict(row)
    document["global_judgment"] = json.loads(document["global_judgment_json"])
    document.pop("global_judgment_json", None)
    return document


def save_pdf_review(
    session_id: str,
    document_id: str,
    review: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    with get_connection() as conn:
        result = conn.execute(
            """
            UPDATE documents
            SET pdf_review_json = ?
            WHERE document_id = ? AND session_id = ?
            """,
            (json.dumps(review), document_id, session_id),
        )
        if result.rowcount == 0:
            return None
    return review



def update_highlight_user_judgment(
    highlight_id: str,
    user_judgment: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    chosen_label = user_judgment.get("chosen_label", "")
    reasoning = user_judgment.get("reasoning", "")
    confidence = user_judgment.get("confidence")
    user_judgment_json = json.dumps(user_judgment)
    with get_connection() as conn:
        result = conn.execute(
            """
            UPDATE highlights
            SET chosen_label = ?, reasoning = ?, confidence = ?, user_judgment_json = ?
            WHERE highlight_id = ?
            """,
            (chosen_label, reasoning, confidence, user_judgment_json, highlight_id),
        )
        if result.rowcount == 0:
            return None
        row = conn.execute(
            "SELECT * FROM highlights WHERE highlight_id = ?",
            (highlight_id,),
        ).fetchone()
    highlight = dict(row)
    raw_judgment = highlight.get("user_judgment_json")
    if raw_judgment:
        highlight["user_judgment"] = json.loads(raw_judgment)
    else:
        highlight["user_judgment"] = {
            "chosen_label": highlight.get("chosen_label"),
            "reasoning": highlight.get("reasoning"),
            "confidence": highlight.get("confidence"),
        }
    highlight.pop("user_judgment_json", None)
    highlight["selector"] = json.loads(highlight["selector_json"])
    highlight.pop("selector_json", None)
    highlight["ai_suggestions"] = json.loads(highlight["ai_suggestions_json"])
    highlight.pop("ai_suggestions_json", None)
    return highlight


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
                if hl_row["user_judgment_json"]:
                    user_judgment = json.loads(hl_row["user_judgment_json"])
                else:
                    user_judgment = {
                        "chosen_label": hl_row["chosen_label"],
                        "reasoning": hl_row["reasoning"],
                        "confidence": hl_row["confidence"],
                    }
                highlights.append(
            {
                "highlight_id": hl_row["highlight_id"],
                "text": hl_row["text"],
                "context": hl_row["context"],
                "selector": json.loads(hl_row["selector_json"]),
                "ai_suggestions": json.loads(hl_row["ai_suggestions_json"]),
                "user_judgment": user_judgment,
                "timestamp": hl_row["timestamp"],
            }
                )

            global_judgment = None
            raw_global = doc_row["global_judgment_json"] if "global_judgment_json" in doc_row.keys() else None
            if raw_global:
                try:
                    global_judgment = json.loads(raw_global)
                except json.JSONDecodeError:
                    global_judgment = raw_global

            pdf_review = None
            raw_review = doc_row["pdf_review_json"] if "pdf_review_json" in doc_row.keys() else None
            if raw_review:
                try:
                    pdf_review = json.loads(raw_review)
                except json.JSONDecodeError:
                    pdf_review = raw_review

            documents.append(
                {
                    "document_id": doc_row["document_id"],
                    "title": doc_row["title"],
                    "url": doc_row["url"],
                    "type": doc_row["type"],
                    "accessed_at": doc_row["accessed_at"],
                    "highlights": highlights,
                    "global_judgment": global_judgment,
                    "pdf_review": pdf_review,
                }
            )

        search_rows = conn.execute(
            "SELECT * FROM search_episodes WHERE session_id = ? ORDER BY timestamp",
            (session_id,),
        ).fetchall()

        search_episodes = [
            {
                "platform": row["platform"],
                "query": row["query"],
                "timestamp": row["timestamp"],
            }
            for row in search_rows
        ]

        interaction_rows = conn.execute(
            "SELECT * FROM interactions WHERE session_id = ? ORDER BY timestamp",
            (session_id,),
        ).fetchall()

        interactions = [
            {
                "interaction_id": row["interaction_id"],
                "interaction_type": row["interaction_type"],
                "payload": json.loads(row["payload_json"]) if row["payload_json"] else {},
                "timestamp": row["timestamp"],
            }
            for row in interaction_rows
        ]

    return {
        "session_id": session_row["session_id"],
        "expert_name": session_row["expert_name"],
        "topic": session_row["topic"],
        "research_goal": session_row["research_goal"],
        "start_time": session_row["start_time"],
        "end_time": session_row["end_time"],
        "documents": documents,
        "search_episodes": search_episodes,
        "interactions": interactions,
    }
