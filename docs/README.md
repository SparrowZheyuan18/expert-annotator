# Expert Annotator

Document-centric expert annotation workflow composed of:

- **Chrome extension** — Captures selections in webpages **and PDF documents**, surfaces AI-assisted suggestions in a side panel, tracks Scholar searches, and sends confirmed highlights to the backend.
- **FastAPI backend** — Persists sessions, documents (HTML/PDF), search episodes, user interactions (e.g., search-result clicks), and highlights in SQLite and provides mock (or proxied) AI suggestions plus JSON export.

This milestone delivers the full HTML + PDF annotation loop:

1. Start a session from the popup (`expert_name`, `topic`, `research_goal`).
2. Activity on Google Scholar or Semantic Scholar is logged automatically: search queries become **search episodes** and opening a result records an **interaction**.
3. While reviewing HTML results, select a snippet to open the side panel decision form (record intent, reasoning, contribution).
4. In PDF mode, select a passage, choose a sentiment, and the viewer renders a coloured annotation while the side panel opens the full highlight form; finish by recording final thoughts and next steps in the summary modal.
5. Every highlight, summary, and ranking is persisted via `/sessions/{id}/documents/{doc}/highlights`, `/summary`, etc., reflected live in the “Saved Notes” panel, and can be exported as structured JSON through `/export/{id}`.

## Repository Layout

- `extension/`
  - `manifest.json` — MV3 manifest registering popup, side panel, background worker, and content script.
  - `popup.html` / `popup.js` — Session management UI (start, export, reset).
  - `sidepanel.html` / `sidepanel.js` / `sidepanel.css` — Highlight review experience.
  - `content.js` — Selection capture, Scholar/Semantic Scholar query detection, and PDF viewer integration.
  - `background.js` — Routes content messages, records search episodes, and launches the internal PDF.js viewer.
  - `api.js` — Shared API + storage helpers for the extension.
  - `vendor/` — Place `pdf.min.js` / `pdf.worker.min.js` (see `docs/PDF_ASSETS.md`).
  - `pdfjs/` — Self-contained PDF viewer assets (loaded via `Open PDF Mode`).
- `server/`
  - `main.py` — FastAPI application exposing session, document, highlight, suggestions, and export endpoints.
  - `storage.py` / `database.py` — SQLite setup and persistence helpers.
  - `requirements.txt` — Python dependencies.
- `docs/`
  - `README.md` — High-level overview (this file).
  - `RUN_LOCAL.md` — Step-by-step run book.
  - `PDF_ASSETS.md` — Instructions for downloading and placing the pdf.js dependencies.
  - `sample_export.json` — Example export payload captured from a real session.
- `.env.example` — Template for local environment variables.
- `.gitignore` — Common ignore rules for Python, Node, and macOS.

## LiteLLM Suggestions

Set up real AI assistance without exposing secrets inside the Chrome extension:

1. Copy `.env.example` to `.env`, choose an `AI_PROVIDER` (`wine` by default, set to `openai` for direct OpenAI access), and provide the matching credentials: `WINE_API_KEY`/`WINE_API_BASE_URL`/`WINE_LLM_MODEL` for the WINE gateway or `OPENAI_API_KEY`/`OPENAI_API_BASE_URL`/`OPENAI_MODEL` for OpenAI. Model names automatically gain the `openai/` prefix so they remain compatible with OpenAI-style gateways; defaults target `openai/wine-gemini-2.5-flash` and `openai/gpt-4.1`.
2. Restart the FastAPI server — it now loads `.env` automatically and keeps the key on the backend only.
3. When you highlight HTML or PDF passages, the extension still calls `/ai/suggestions`, but the server now uses LiteLLM to call whichever provider you selected and returns three actionable research follow-ups to the UI.

Because the key never ships with the extension bundle, end users cannot inspect or tamper with it from Chrome DevTools. You can still set `AI_API_URL` to proxy requests elsewhere if desired.
