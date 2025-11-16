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
6. Visit any article/blog page并选中文本——侧边栏会根据上下文展示 **Search Result** 表单：选择 “I want/I don't want to click this”，填写两个原因字段后保存，后端会记录新的 highlight 和 interaction。
7. Browse 到 <https://scholar.google.com/scholar?q=test>（或 Semantic Scholar）。侧边栏应提示 `Recorded search...`，并在你点击任意搜索结果后将行为写入 `/sessions/{id}/interactions`。
8. 打开某条 PDF 结果。原页面持续可浏览；侧边栏的 **Open PDF Mode** 按钮启用，点击后进入扩展内置的 PDF.js 查看器。若尚未放置 pdf.js 资源，请按 `extension/vendor/README.md` 下载 `pdf.min.js` 与 `pdf.worker.min.js`。
9. 在 viewer 中选择段落时，会先出现轻量工具条；点击 “Highlight” 后，标注既会在侧边栏记录，也会直接在 PDF 页面上以荧光笔样式高亮显示（再次点击高亮即可取消）。完成标注后可在工具栏里点击 **Complete Paper**，输入 final thoughts 和 next steps。
10. 侧边栏会同步显示该 PDF 的总结信息，再点击 **Finish Research** 结束整个会话；popup 会显示 Ended 时间戳，并自动下载 `session-<id>.json`。
11. 任意时刻可通过 popup 或侧边栏的 **Export** 按钮导出当前 JSON。

## Notes

- CORS is enabled for `http://localhost`, `http://127.0.0.1`, `http://127.0.0.1:8000`, and `chrome-extension://*` origins in `server/main.py`.
- Update `.env` (copy from `.env.example`) if additional configuration is needed.
- Optional: set `AI_PROVIDER` to `wine` (default) or `openai` and provide the matching credentials (`WINE_API_KEY`/`WINE_LLM_MODEL` or `OPENAI_API_KEY`/`OPENAI_MODEL`) so the backend uses LiteLLM to call your preferred OpenAI-compatible gateway for `/ai/suggestions`. Model names automatically gain the `openai/` prefix for API compatibility. You can still provide an `AI_API_URL` if you prefer forwarding to a different service.
- 将 pdf.js 的 `pdf.min.js` 和 `pdf.worker.min.js` 复制到 `extension/vendor/` 目录（参见 `extension/vendor/README.md`）。扩展会从本地加载这些文件以支持 PDF 渲染。
