# PDF.js 本地资源

扩展在 `extension/vendor/` 目录下查找 `pdf.min.js` 与 `pdf.worker.min.js`，用来渲染 PDF 并捕获文本高亮。由于开发环境可能无法访问公共 CDN，需要手动下载一次：

```bash
curl -L https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js -o extension/vendor/pdf.min.js
curl -L https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js -o extension/vendor/pdf.worker.min.js
```

完成后重新加载 Chrome 扩展即可。若需要使用其它版本的 pdf.js，请同时替换 core 和 worker，确保版本一致。
