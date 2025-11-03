# Expert Annotator

Document-centric expert annotation workflow composed of:

- **Chrome extension** — Captures selections in webpages **and PDF documents**, surfaces AI-assisted suggestions in a side panel, tracks Scholar searches, and sends confirmed highlights to the backend.
- **FastAPI backend** — Persists sessions, documents (HTML/PDF), search episodes, user interactions (e.g., search-result clicks), and highlights in SQLite and provides mock (or proxied) AI suggestions plus JSON export.

This milestone delivers the full HTML + PDF annotation loop:

1. Start a session from the popup (`expert_name`, `topic`, `research_goal`).
2. When使用 Google Scholar 或 Semantic Scholar，查询会被记录为 **search episodes**，点击某个搜索结果也会同步写入 **interactions**。
3. 在搜索阶段（HTML 列表）选中一条内容 → 侧边栏展示决策表单（是否点击、原因、贡献）。
4. 在 PDF 阶段，选中段落会先弹出轻量工具条，点击 “Highlight” 后侧边栏展开标注卡片，同时在 PDF 页面上渲染醒目的荧光笔高亮；完成阅读后可在 viewer 中输入 final thoughts 与下一步行动。
5. 所有信息通过 `/sessions/{id}/documents/{doc}/highlights`、`/summary` 等接口持久化，并在侧边栏的 “Saved Notes” 区块实时展示；点击任意笔记即可重新编辑，最终可通过 `/export/{id}` 下载结构化 JSON。

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
  - `PDF_ASSETS.md` — 下载并放置 pdf.js 依赖的说明。
  - `sample_export.json` — Example export payload captured from a real session.
- `.env.example` — Template for local environment variables.
- `.gitignore` — Common ignore rules for Python, Node, and macOS.
