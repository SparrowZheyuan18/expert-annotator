# Run Locally

## Backend (FastAPI)

1. **Create a virtual environment (optional):**
   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   ```
   On Windows (PowerShell):
   ```powershell
   python -m venv .venv
   .\.venv\Scripts\Activate.ps1
   ```
2. **Install dependencies:**
   ```bash
   pip install -r server/requirements.txt
   ```
3. **Start the development server:**
   ```bash
   uvicorn server.main:app --reload --port 8000
   ```
   Run this command from the repository root or the `server/` directory.
4. **Verify the health endpoint:** open <http://127.0.0.1:8000/healthz>. Expected response:
   ```json
   {"ok": true, "service": "expert-annotator", "version": "0.3.0"}
   ```

## Chrome Extension

1. Open Chrome and navigate to `chrome://extensions/`.
2. Toggle **Developer mode** (top-right corner).
3. Click **Load unpacked** and select the `extension/` directory from this repository.
4. Pin the **Expert Annotator** icon from the puzzle-piece menu (optional but convenient).
5. Click the toolbar icon to open the popup and complete the **Start Session** form.
6. Visit any article or blog page and select text. The side panel will show the **Search Result** form based on context: choose "I want/I don't want to click this", fill in both reason fields, and save. The backend will record the new highlight and interaction.
7. Browse to <https://scholar.google.com/scholar?q=test> (or Semantic Scholar). The side panel should display `Recorded search...`, and clicking any search result will write the interaction to `/sessions/{id}/interactions`.
8. Open a PDF result. The original page remains browsable; the side panel enables the **Open PDF Mode** button. Click it to enter the extension's built-in PDF.js viewer. If pdf.js assets are not in place yet, follow `extension/vendor/README.md` to download `pdf.min.js` and `pdf.worker.min.js`.
9. When selecting a paragraph in the viewer, a lightweight toolbar appears first. After clicking "Highlight", the annotation is both recorded in the side panel and shown directly on the PDF page with a marker-style highlight (click the highlight again to remove it). After annotating, click **Complete Paper** in the toolbar and enter final thoughts and next steps.
10. The side panel will sync and display the PDF summary. Then click **Finish Research** to end the full session; the popup shows the Ended timestamp and automatically downloads `session-<id>.json`.
11. At any time, you can export the current JSON from the **Export** button in either the popup or the side panel.

## Notes

- CORS is enabled for `http://localhost`, `http://127.0.0.1`, `http://127.0.0.1:8000`, and `chrome-extension://*` origins in `server/main.py`.
- Update `.env` (copy from `.env.example`) if additional configuration is needed.
- Optional: set `AI_PROVIDER` to `wine` (default) or `openai` and provide the matching credentials (`WINE_API_KEY`/`WINE_LLM_MODEL` or `OPENAI_API_KEY`/`OPENAI_MODEL`) so the backend uses LiteLLM to call your preferred OpenAI-compatible gateway for `/ai/suggestions`. Model names automatically gain the `openai/` prefix for API compatibility. You can still provide an `AI_API_URL` if you prefer forwarding to a different service.
- Copy `pdf.min.js` and `pdf.worker.min.js` from pdf.js into `extension/vendor/` (see `extension/vendor/README.md`). The extension loads these files locally to support PDF rendering.
