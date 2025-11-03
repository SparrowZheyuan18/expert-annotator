# Expert Annotator API

FastAPI backend that powers the document-centric expert annotation workflow. This milestone introduces persistent sessions, document/PDF support, search-episode tracking, highlight storage, mock (or proxied) AI suggestions, and a structured export endpoint.

SQLite is used for persistence (`server/expert_annotator.db`). Tables are created automatically on first run.

## Endpoints

- `GET /healthz` — Service liveness probe returning `{ok, service, version}`.
- `POST /sessions` — Create a new annotation session. Request body: `{expert_name, topic, research_goal}`. Returns session metadata (including `session_id` and timestamps).
- `POST /sessions/{session_id}/documents` — Register or retrieve a document within a session. Duplicate calls with the same URL return the same `document_id`. `type` may be `html` or `pdf`.
- `POST /sessions/{session_id}/documents/{document_id}/highlights` — Persist a highlight with selector data, AI suggestions, and user judgment. Accepts both TextQuote (`html`) and PDFText (`pdf`) selectors。
- `POST /sessions/{session_id}/search-episodes` — Log a search query against Google Scholar or Semantic Scholar.
- `POST /sessions/{session_id}/interactions` — Record lightweight user interactions (e.g., opening a search result).
- `POST /sessions/{session_id}/documents/{document_id}/summary` — Save final thoughts / next steps for a document (populates `global_judgment`).
- `POST /sessions/{session_id}/complete` — Mark a session as finished and stamp the `end_time`.
- `POST /ai/suggestions` — Mock endpoint returning three canned suggestions. Set `AI_API_URL` in the environment to proxy to a real service instead.
- `GET /export/{session_id}` — Full session export containing session metadata, documents (with highlights & summaries), search episodes, and recorded interactions.

Example: creating a PDF highlight

```http
POST /sessions/{session}/documents/{doc}/highlights
Content-Type: application/json

{
  "text": "Important passage",
  "selector": {
    "type": "PDFText",
    "page": 3,
    "text": "...",
    "coords": {"x1": 12.5, "y1": 88.0, "x2": 240.0, "y2": 112.0},
    "rects": [
      {"x1": 12.5, "y1": 88.0, "x2": 240.0, "y2": 100.0, "width": 227.5, "height": 12.0}
    ]
  },
  "ai_suggestions": ["...", "...", "..."],
  "user_judgment": {
    "chosen_label": "PDF Highlight",
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
