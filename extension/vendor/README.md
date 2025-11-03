# PDF.js Assets

Place `pdf.min.js` and `pdf.worker.min.js` from a compatible pdf.js release (e.g., 2.16.105) into this directory.

Download commands (run once with network access):

```bash
curl -L https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js -o extension/vendor/pdf.min.js
curl -L https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js -o extension/vendor/pdf.worker.min.js
```

The extension loads these local copies to render PDFs offline.
