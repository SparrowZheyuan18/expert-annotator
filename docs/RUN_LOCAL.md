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
   {"ok": true, "service": "expert-annotator", "version": "0.2.0"}
   ```

## Chrome Extension

1. Open Chrome and navigate to `chrome://extensions/`.
2. Toggle **Developer mode** (top-right corner).
3. Click **Load unpacked** and select the `extension/` directory from this repository.
4. Pin the **Expert Annotator** icon from the puzzle-piece menu (optional but convenient).
5. Click the toolbar icon to open the popup and complete the **Start Session** form.
6. Visit any article/blog page and select text with the mouse — the side panel opens automatically with AI suggestions.
7. Choose a label, adjust the reasoning, and click **Save highlight**.
8. Use the popup or side panel **Export** button to open the structured session JSON in a new tab.

## Notes

- CORS is enabled for `http://localhost`, `http://127.0.0.1`, `http://127.0.0.1:8000`, and `chrome-extension://*` origins in `server/main.py`.
- Update `.env` (copy from `.env.example`) if additional configuration is needed.
