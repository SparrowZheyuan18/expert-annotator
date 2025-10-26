# Expert Annotator

Document-centric expert annotation workflow composed of:

- **Chrome extension** — Captures selections in any webpage, surfaces AI-assisted suggestions in a side panel, and sends confirmed highlights to the backend.
- **FastAPI backend** — Persists sessions, documents, and highlights in SQLite and provides mock AI suggestions plus JSON export.

This milestone delivers the full HTML annotation loop:

1. Start a session from the popup (`expert_name`, `topic`, `research_goal`).
2. Select text in any page → side panel opens, fetches `/ai/suggestions`, and displays editable cards.
3. Save highlights to `/sessions/{id}/documents/{doc}/highlights`.
4. Export the session via `/export/{id}` for structured JSON output.

## Repository Layout

- `extension/`
  - `manifest.json` — MV3 manifest registering popup, side panel, background worker, and content script.
  - `popup.html` / `popup.js` — Session management UI (start, export, reset).
  - `sidepanel.html` / `sidepanel.js` / `sidepanel.css` — Highlight review experience.
  - `content.js` — Selection capture and selector generation.
  - `background.js` — Routes content messages to the side panel.
  - `api.js` — Shared API + storage helpers for the extension.
- `server/`
  - `main.py` — FastAPI application exposing session, document, highlight, suggestions, and export endpoints.
  - `storage.py` / `database.py` — SQLite setup and persistence helpers.
  - `requirements.txt` — Python dependencies.
- `docs/`
  - `README.md` — High-level overview (this file).
  - `RUN_LOCAL.md` — Step-by-step run book.
  - `sample_export.json` — Example export payload captured from a real session.
- `.env.example` — Template for local environment variables.
- `.gitignore` — Common ignore rules for Python, Node, and macOS.
