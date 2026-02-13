# PDF.js Local Assets

The extension looks for `pdf.min.js` and `pdf.worker.min.js` in `extension/vendor/` to render PDFs and capture text highlights. Since some development environments cannot access public CDNs, download these files once manually:

```bash
curl -L https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js -o extension/vendor/pdf.min.js
curl -L https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js -o extension/vendor/pdf.worker.min.js
```

After downloading, reload the Chrome extension. If you need a different pdf.js version, replace both the core and worker files so their versions stay aligned.
