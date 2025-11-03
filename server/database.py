from __future__ import annotations

import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent / "expert_annotator.db"


def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


def init_db() -> None:
    conn = get_connection()
    with conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                session_id TEXT PRIMARY KEY,
                expert_name TEXT NOT NULL,
                topic TEXT NOT NULL,
                research_goal TEXT NOT NULL,
                start_time TEXT NOT NULL,
                end_time TEXT
            );
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS documents (
                document_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                title TEXT NOT NULL,
                url TEXT NOT NULL,
                type TEXT NOT NULL,
                accessed_at TEXT NOT NULL,
                global_judgment_json TEXT,
                pdf_review_json TEXT,
                UNIQUE(session_id, url),
                FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
            );
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS highlights (
                highlight_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                document_id TEXT NOT NULL,
                text TEXT NOT NULL,
                context TEXT,
                selector_json TEXT NOT NULL,
                ai_suggestions_json TEXT NOT NULL,
                chosen_label TEXT NOT NULL,
                reasoning TEXT NOT NULL,
                confidence REAL,
                user_judgment_json TEXT,
                timestamp TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
                FOREIGN KEY (document_id) REFERENCES documents(document_id) ON DELETE CASCADE
            );
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS search_episodes (
                episode_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                platform TEXT NOT NULL,
                query TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
            );
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS interactions (
                interaction_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                interaction_type TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
            );
            """
        )

        # Apply schema migrations for existing databases
        try:
            conn.execute("ALTER TABLE documents ADD COLUMN global_judgment_json TEXT")
        except sqlite3.OperationalError:
            pass

        try:
            conn.execute("ALTER TABLE highlights ADD COLUMN user_judgment_json TEXT")
        except sqlite3.OperationalError:
            pass

        try:
            conn.execute("ALTER TABLE highlights ADD COLUMN context TEXT")
        except sqlite3.OperationalError:
            pass
        try:
            conn.execute("ALTER TABLE documents ADD COLUMN pdf_review_json TEXT")
        except sqlite3.OperationalError:
            pass
    conn.close()


# Initialize tables when the module is imported.
init_db()
