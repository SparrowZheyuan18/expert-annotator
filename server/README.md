# Expert Annotator API

FastAPI backend that powers the document-centric expert annotation workflow. This milestone introduces persistent sessions, document deduplication, highlight storage, mock AI suggestions, and a structured export endpoint.

SQLite is used for persistence (`server/expert_annotator.db`). Tables are created automatically on first run.

## Endpoints

- `GET /healthz` — Service liveness probe returning `{ok, service, version}`.
- `POST /sessions` — Create a new annotation session. Request body: `{expert_name, topic, research_goal}`. Returns session metadata (including `session_id` and timestamps).
- `POST /sessions/{session_id}/documents` — Register or retrieve a document within a session. Duplicate calls with the same URL return the same `document_id`.
- `POST /sessions/{session_id}/documents/{document_id}/highlights` — Persist a highlight with selector data, AI suggestions, and user judgment.
- `POST /ai/suggestions` — Mock endpoint that returns three canned suggestions for a highlight.
- `GET /export/{session_id}` — Full session export matching the MVP schema (documents, highlights, search episodes placeholder).

Example: creating a highlight

```http
POST /sessions/{session}/documents/{doc}/highlights
Content-Type: application/json

{
  "text": "Important passage",
  "selector": { "type": "TextQuote", "exact": "...", "prefix": "...", "suffix": "..." },
  "ai_suggestions": ["...", "...", "..."],
  "user_judgment": {
    "chosen_label": "Core Concept",
    "reasoning": "Matches the stated goal",
    "confidence": 0.9
  }
}
```

## Local Development

1. Create and activate a virtual environment (optional but recommended).
2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```
3. Run the development server (from the repository root or `server/` directory):
   ```bash
   uvicorn server.main:app --reload --port 8000
   ```
4. Visit <http://127.0.0.1:8000/healthz> to confirm the service responds.

## CORS Policy

CORS is enabled for:

- `http://localhost`
- `http://127.0.0.1`
- `http://127.0.0.1:8000`
- Any Chrome extension origin (`chrome-extension://*`)

Adjust `allowed_origins` or `allow_origin_regex` in `server/main.py` if additional origins are required.
