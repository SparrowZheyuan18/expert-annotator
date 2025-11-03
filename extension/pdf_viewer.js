/* global chrome */

if (window.__EA_PDF_VIEWER_LOADED__) {
  console.warn("Expert Annotator PDF viewer script already initialized.");
} else {
  window.__EA_PDF_VIEWER_LOADED__ = true;

  (async () => {
    const params = new URLSearchParams(window.location.search);
    const originalUrl = params.get("src") ? decodeURIComponent(params.get("src")) : "";
    const originalTitle = params.get("title") ? decodeURIComponent(params.get("title")) : "PDF Document";

    const viewerEl = document.getElementById("viewer");
    const titleEl = document.getElementById("doc-title");
    const urlEl = document.getElementById("doc-url");
    const openOriginalBtn = document.getElementById("open-original");
    const toggleTextLayerBtn = document.getElementById("toggle-text-layer");
    const zoomInBtn = document.getElementById("zoom-in");
    const zoomOutBtn = document.getElementById("zoom-out");
    const fitWidthBtn = document.getElementById("fit-width");
    const zoomLevelLabel = document.getElementById("zoom-level");
    const completeDocumentBtn = document.getElementById("complete-document");

    const annotatorApi = window.EXPERT_ANNOTATOR?.api;
    const annotatorStorage = window.EXPERT_ANNOTATOR?.storage;
    const storageKeys = window.EXPERT_ANNOTATOR?.storage?.keys || { SESSION: "session", DOCUMENTS: "documents" };

    const PDFJS_CORE_URL = chrome.runtime.getURL("vendor/pdf.min.js");
    const PDFJS_WORKER_URL = chrome.runtime.getURL("vendor/pdf.worker.min.js");

    let textLayerVisible = true;
    let lastSelectionSignature = null;
    let pdfjsLib = null;
    let pdfjsLoaderPromise = null;
    let currentPdf = null;
    let currentScale = 1.0;
    let pageOriginalWidths = new Map();
    let pageViewports = new Map();
    let pendingSelection = null;
    let selectionToolbar = null;
    const pageHighlightLayers = new Map(); // page -> overlay element
    const pageHighlightData = new Map(); // page -> [{x1,y1,x2,y2,color,localId,highlightId}]
    const pendingHighlightQueue = new Map(); // page -> raw rects awaiting viewport
    let highlightActionPopover = null;
    let highlightActionTarget = null;
    const DEFAULT_PDF_SENTIMENT = "thumbsup";
    const PDF_REVIEW_SENTIMENTS = [
      { value: "thumbsup", label: "Thumbs up" },
      { value: "neutral_information", label: "Neutral information" },
      { value: "thumbsdown", label: "Thumbs down" },
    ];
    const PDF_SENTIMENT_ALIAS_MAP = {
      "thumbs up": "thumbsup",
      "👍": "thumbsup",
      thumbsup: "thumbsup",
      "thumbs down": "thumbsdown",
      "thumbs-down": "thumbsdown",
      "👎": "thumbsdown",
      thumbsdown: "thumbsdown",
      "neutral information": "neutral_information",
      "neutral-information": "neutral_information",
      neutral_information: "neutral_information",
      "pdf highlight": "neutral_information",
      "core concept": "thumbsup",
      "not relevant": "thumbsdown",
      "method weakness": "thumbsdown",
      "generate new search": "neutral_information",
      "search result": "neutral_information",
    };
    function normalisePdfSentimentValue(rawValue) {
      if (rawValue === null || rawValue === undefined) {
        return DEFAULT_PDF_SENTIMENT;
      }
      const key = String(rawValue).trim().toLowerCase();
      if (!key) {
        return DEFAULT_PDF_SENTIMENT;
      }
      return (
        PDF_SENTIMENT_ALIAS_MAP[key]
        || (PDF_REVIEW_SENTIMENTS.some((option) => option.value === key) ? key : DEFAULT_PDF_SENTIMENT)
      );
    }

    function resolveOverlayColor(rawColor, { highlightId } = {}) {
      if (typeof rawColor === "string") {
        const colourKey = rawColor.toLowerCase();
        if (colourKey === "positive" || colourKey === "negative" || colourKey === "neutral") {
          return colourKey;
        }
        if (colourKey === "secondary") {
          return "neutral";
        }
        const normalizedSentiment = normalisePdfSentimentValue(colourKey);
        if (normalizedSentiment === "thumbsup") {
          return "positive";
        }
        if (normalizedSentiment === "thumbsdown") {
          return "negative";
        }
        if (normalizedSentiment === "neutral_information") {
          return "neutral";
        }
      }
      return highlightId ? "neutral" : "neutral";
    }

    function safeSendMessage(message, retries = 1) {
      if (!chrome.runtime || !chrome.runtime.id || typeof chrome.runtime.sendMessage !== "function") {
        console.debug("PDF viewer: runtime unavailable, skipping message", message?.type);
        return;
      }
      try {
        chrome.runtime.sendMessage(message, () => {
          if (chrome.runtime.lastError) {
            const errMsg = chrome.runtime.lastError.message || "unknown";
            console.debug("PDF viewer: message failed", message?.type, errMsg);
            if (retries > 0 && errMsg.includes("Extension context invalidated")) {
              setTimeout(() => safeSendMessage(message, retries - 1), 200);
            }
          }
        });
      } catch (error) {
        console.debug("PDF viewer: message error", message?.type, error);
      }
    }

    function updateDocumentMetadata() {
      if (originalUrl) {
        document.title = `${originalTitle} – Expert Annotator`;
      }
      titleEl.textContent = originalTitle || "PDF Viewer";
      urlEl.textContent = originalUrl;
    }

    function openOriginal() {
      if (originalUrl) {
        chrome.tabs.create({ url: originalUrl });
      }
    }

    async function ensurePdfJs() {
      if (pdfjsLib) {
        return pdfjsLib;
      }
      if (!pdfjsLoaderPromise) {
        pdfjsLoaderPromise = new Promise((resolve, reject) => {
          const script = document.createElement("script");
          script.src = PDFJS_CORE_URL;
          script.type = "text/javascript";
          script.onload = () => {
            pdfjsLib = window.pdfjsLib;
            if (!pdfjsLib) {
              reject(new Error("pdf.js library failed to initialize"));
              return;
            }
            pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
            resolve(pdfjsLib);
          };
          script.onerror = () => reject(new Error("Unable to load pdf.js core script"));
          document.head.appendChild(script);
        });
      }
      return pdfjsLoaderPromise;
    }

    async function loadPdf(url) {
      const lib = await ensurePdfJs();
      const loadingTask = lib.getDocument({ url, withCredentials: false });
      currentPdf = await loadingTask.promise;
      pageOriginalWidths = new Map();
      pageViewports = new Map();
      await renderAllPages();

      const fitScale = computeFitScale();
      if (Math.abs(fitScale - currentScale) > 0.01) {
        currentScale = fitScale;
        await renderAllPages();
      } else {
        updateZoomLabel();
      }
    }

    async function renderAllPages() {
      if (!currentPdf) return;

      viewerEl.innerHTML = "";
      const lib = await ensurePdfJs();
      pageHighlightLayers.clear();

      for (let pageNumber = 1; pageNumber <= currentPdf.numPages; pageNumber += 1) {
        // eslint-disable-next-line no-await-in-loop
        const page = await currentPdf.getPage(pageNumber);
        const baseViewport = page.getViewport({ scale: 1 });
        pageOriginalWidths.set(pageNumber, baseViewport.width);
        const viewport = baseViewport.clone({ scale: currentScale });
        pageViewports.set(pageNumber, viewport);
        const outputScale = window.devicePixelRatio || 1;

        const pageContainer = document.createElement("div");
        pageContainer.className = "page";
        pageContainer.dataset.pageNumber = String(pageNumber);

        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d", { willReadFrequently: true });
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        pageContainer.appendChild(canvas);

        const renderContext = {
          canvasContext: context,
          viewport,
          transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null,
        };
        await page.render(renderContext).promise;

        const textLayerDiv = document.createElement("div");
        textLayerDiv.className = "text-layer";
        textLayerDiv.dataset.pageNumber = String(pageNumber);
        if (!textLayerVisible) textLayerDiv.classList.add("hidden");
        pageContainer.appendChild(textLayerDiv);

        const textContent = await page.getTextContent();
        await lib.renderTextLayer({
          textContent,
          container: textLayerDiv,
          viewport,
          textDivs: [],
          enhanceTextSelection: true,
        }).promise;

        const annotationLayerDiv = document.createElement("div");
        annotationLayerDiv.className = "annotation-layer";
        pageContainer.appendChild(annotationLayerDiv);
        const annotations = await page.getAnnotations({ intent: "display" });
        if (annotations.length > 0 && lib.AnnotationLayer) {
          lib.AnnotationLayer.render({
            annotations,
            div: annotationLayerDiv,
            page,
            viewport: viewport.clone({ dontFlip: true }),
            renderInteractiveForms: false,
            linkService: {
              externalLinkTarget: "_blank",
              externalLinkRel: "noopener noreferrer",
              getDestinationHash: (dest) => dest,
              navigateTo: (dest) => console.debug("PDF link navigate", dest),
              addLinkAttributes: (element, url) => {
                element.href = url;
                element.target = "_blank";
                element.rel = "noopener noreferrer";
              },
              getNamedDestination: () => Promise.resolve(undefined),
            },
          });
        }

        const overlayDiv = document.createElement("div");
        overlayDiv.className = "highlight-overlay";
        pageContainer.appendChild(overlayDiv);
        pageHighlightLayers.set(pageNumber, overlayDiv);
        renderOverlayForPage(pageNumber);
        flushPendingHighlights(pageNumber);

        viewerEl.appendChild(pageContainer);
      }

      updateZoomLabel();
    }

    function computeFitScale() {
      if (!pageOriginalWidths.size) {
        return currentScale;
      }
      const containerWidth = Math.max(viewerEl.getBoundingClientRect().width - 32, 320);
      const maxBaseWidth = Math.max(...pageOriginalWidths.values());
      if (!maxBaseWidth) {
        return currentScale;
      }
      const scale = containerWidth / maxBaseWidth;
      return Math.max(Math.min(scale, 4), 0.5);
    }

    function setScale(scale, { type }) {
      const clamped = Math.max(0.5, Math.min(scale, 4));
      if (Math.abs(clamped - currentScale) < 0.01) {
        return;
      }
      currentScale = clamped;
      renderAllPages();
      console.debug("PDF zoom", { type, scale: currentScale });
    }

    function updateZoomLabel() {
      zoomLevelLabel.textContent = `${Math.round(currentScale * 100)}%`;
      fitWidthBtn.disabled = pageOriginalWidths.size === 0;
    }

    function handleTextLayerToggle() {
      textLayerVisible = !textLayerVisible;
      viewerEl.querySelectorAll(".text-layer").forEach((layer) => {
        layer.classList.toggle("hidden", !textLayerVisible);
      });
      toggleTextLayerBtn.textContent = textLayerVisible ? "Hide Text Layer" : "Show Text Layer";
    }

    function handleSelection() {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        removeSelectionToolbar();
        return;
      }

      const text = selection.toString().trim();
      if (!text) {
        removeSelectionToolbar();
        return;
      }

      const range = selection.getRangeAt(0);
      const container =
        range.commonAncestorContainer instanceof Element
          ? range.commonAncestorContainer
          : range.commonAncestorContainer.parentElement;
      if (!container) {
        return;
      }
      const pageEl = container.closest(".page");
      if (!pageEl) {
        return;
      }
      const pageNumber = Number(pageEl.dataset.pageNumber);
      if (!pageNumber) {
        return;
      }

      const selectionRect = range.getBoundingClientRect();
      const pageRect = pageEl.getBoundingClientRect();
      const clientRects = Array.from(range.getClientRects());
      const rects = clientRects.map((rect) => ({
        x1: Number((rect.left - pageRect.left).toFixed(2)),
        y1: Number((rect.top - pageRect.top).toFixed(2)),
        x2: Number((rect.right - pageRect.left).toFixed(2)),
        y2: Number((rect.bottom - pageRect.top).toFixed(2)),
        width: Number(rect.width.toFixed(2)),
        height: Number(rect.height.toFixed(2)),
      }));
      const primaryRect = rects[0] || {
        x1: Number((selectionRect.left - pageRect.left).toFixed(2)),
        y1: Number((selectionRect.top - pageRect.top).toFixed(2)),
        x2: Number((selectionRect.right - pageRect.left).toFixed(2)),
        y2: Number((selectionRect.bottom - pageRect.top).toFixed(2)),
        width: Number(selectionRect.width.toFixed(2)),
        height: Number(selectionRect.height.toFixed(2)),
      };

      const signature = JSON.stringify([text, pageNumber, primaryRect.x1, primaryRect.y1, rects.length]);
      if (signature === lastSelectionSignature) {
        return;
      }
      lastSelectionSignature = signature;

      const cloned = range.cloneContents();
      const linkNodes = cloned.querySelectorAll("a[href]");
      const links = Array.from(linkNodes, (anchor) => ({
        href: anchor.href,
        text: anchor.textContent || anchor.href,
      })).slice(0, 10);

      pendingSelection = {
        text,
        selector: {
          type: "PDFText",
          page: pageNumber,
          text,
          coords: {
            x1: primaryRect.x1,
            y1: primaryRect.y1,
            x2: primaryRect.x2,
            y2: primaryRect.y2,
          },
          rects,
        },
        links,
        sentiment: null,
      };

      showSelectionToolbar({
        left: selectionRect.right + 6,
        top: selectionRect.top - 8,
      });
    }

    function resetSelectionSignature(event) {
      if (selectionToolbar && event?.target && selectionToolbar.contains(event.target)) {
        return;
      }
      lastSelectionSignature = null;
      pendingSelection = null;
      removeSelectionToolbar();
    }

    function handleResize() {
      if (!pageOriginalWidths.size) {
        return;
      }
      const fitScale = computeFitScale();
      if (Math.abs(fitScale - currentScale) > 0.05) {
        setScale(fitScale, { type: "resize-fit" });
      }
    }

    updateDocumentMetadata();

    openOriginalBtn.addEventListener("click", openOriginal);
    toggleTextLayerBtn.addEventListener("click", handleTextLayerToggle);
    zoomInBtn.addEventListener("click", () => setScale(currentScale * 1.2, { type: "zoom-in" }));
    zoomOutBtn.addEventListener("click", () => setScale(currentScale / 1.2, { type: "zoom-out" }));
    fitWidthBtn.addEventListener("click", () => setScale(computeFitScale(), { type: "fit-width" }));
    completeDocumentBtn.addEventListener("click", openSummaryModal);

    document.addEventListener("selectionchange", () => {
      setTimeout(handleSelection, 50);
    });
    document.addEventListener("mousedown", resetSelectionSignature);
    window.addEventListener("resize", handleResize);
    window.addEventListener("beforeunload", () => {
      pdfjsLoaderPromise = null;
      pdfjsLib = null;
      pageOriginalWidths = new Map();
      pageViewports = new Map();
      pageHighlightLayers.clear();
      pageHighlightData.clear();
    });

    if (!originalUrl) {
      viewerEl.innerHTML = '<p class="error">Missing PDF source URL.</p>';
      return;
    }

    try {
      await loadPdf(originalUrl);
    } catch (error) {
      console.error(error);
      viewerEl.innerHTML = `<p class="error">Failed to load PDF: ${error.message}</p>`;
    }

    function removeSelectionToolbar() {
      if (selectionToolbar) {
        selectionToolbar.remove();
        selectionToolbar = null;
      }
    }

    function showSelectionToolbar(position) {
      removeSelectionToolbar();
      if (!pendingSelection) {
        return;
      }
      const toolbar = document.createElement("div");
      toolbar.className = "highlight-toolbar";

      const sentimentSelect = document.createElement("select");
      sentimentSelect.className = "highlight-toolbar__select";
      const placeholderOpt = document.createElement("option");
      placeholderOpt.value = "";
      placeholderOpt.textContent = "Select sentiment";
      placeholderOpt.disabled = true;
      placeholderOpt.selected = true;
      sentimentSelect.appendChild(placeholderOpt);
      PDF_REVIEW_SENTIMENTS.forEach((option) => {
        const opt = document.createElement("option");
        opt.value = option.value;
        opt.textContent = option.label;
        sentimentSelect.appendChild(opt);
      });
      sentimentSelect.addEventListener("change", () => {
        if (!sentimentSelect.value) {
          return;
        }
        pendingSelection.sentiment = sentimentSelect.value;
        commitPendingSelection();
      });
      toolbar.appendChild(sentimentSelect);

      toolbar.style.top = `${Math.max(position.top, 16)}px`;
      toolbar.style.left = `${position.left}px`;
      document.body.appendChild(toolbar);
      selectionToolbar = toolbar;

      const measurements = toolbar.getBoundingClientRect();
      const maxLeft = window.innerWidth - measurements.width - 16;
      const maxTop = window.innerHeight - measurements.height - 16;
      const desiredLeft = Math.min(Math.max(parseFloat(toolbar.style.left), 16), maxLeft);
      const desiredTop = Math.min(Math.max(parseFloat(toolbar.style.top), 16), maxTop);
      toolbar.style.left = `${desiredLeft}px`;
      toolbar.style.top = `${desiredTop}px`;
    }

    function commitPendingSelection() {
      if (!pendingSelection) {
        return;
      }
      const sentiment = normalisePdfSentimentValue(pendingSelection.sentiment || DEFAULT_PDF_SENTIMENT);
      pendingSelection.sentiment = sentiment;
      const { page } = pendingSelection.selector;
      const localId = `pdf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      pendingSelection.localId = localId;
      const overlayColor = (() => {
        if (sentiment === "thumbsup") return "positive";
        if (sentiment === "thumbsdown") return "negative";
        return "neutral";
      })();
      if (page && Array.isArray(pendingSelection.selector.rects) && pendingSelection.selector.rects.length) {
        const overlayRects = pendingSelection.selector.rects.map((rect) => ({
          ...rect,
          color: overlayColor,
          localId,
        }));
        addOverlayHighlights(page, overlayRects);
      }
      safeSendMessage(
        {
          type: "PDF_SELECTION",
          payload: {
            text: pendingSelection.text,
            selector: pendingSelection.selector,
            sentiment,
            user_judgment: {
              chosen_label: sentiment,
            },
            meta: {
              title: originalTitle,
              url: originalUrl,
              accessed_at: new Date().toISOString(),
              type: "pdf",
              links: pendingSelection.links,
            },
            local_id: localId,
          },
        },
        2
      );
      pendingSelection = null;
      lastSelectionSignature = null;
      removeSelectionToolbar();
    }

    function normaliseRect(rect, viewport) {
      return {
        x1: rect.x1 / viewport.width,
        y1: rect.y1 / viewport.height,
        x2: rect.x2 / viewport.width,
        y2: rect.y2 / viewport.height,
      };
    }

    function renderOverlayForPage(pageNumber) {
      const overlayDiv = pageHighlightLayers.get(pageNumber);
      if (!overlayDiv) {
        return;
      }
      overlayDiv.innerHTML = "";
      const viewport = pageViewports.get(pageNumber);
      if (!viewport) {
        return;
      }
      const marks = pageHighlightData.get(pageNumber) || [];
      marks.forEach((mark, index) => {
        const div = document.createElement("div");
        div.className = "highlight-overlay__mark";
        if (mark.color === "positive") {
          div.classList.add("pdf-highlight-positive");
        } else if (mark.color === "negative") {
          div.classList.add("pdf-highlight-negative");
        } else if (mark.color === "neutral") {
          div.classList.add("pdf-highlight-neutral");
        } else if (mark.color === "secondary") {
          div.classList.add("pdf-highlight-secondary");
        }
        const x = mark.x1 * viewport.width;
        const y = mark.y1 * viewport.height;
        const width = (mark.x2 - mark.x1) * viewport.width;
        const height = (mark.y2 - mark.y1) * viewport.height;
        div.style.left = `${x}px`;
        div.style.top = `${y}px`;
        div.style.width = `${Math.max(width, 2)}px`;
        div.style.height = `${Math.max(height, 2)}px`;
        div.dataset.markIndex = String(index);
        if (mark.fingerprint) {
          div.dataset.fingerprint = mark.fingerprint;
        }
        if (mark.localId) {
          div.dataset.localId = mark.localId;
        }
        if (mark.highlightId) {
          div.dataset.highlightId = mark.highlightId;
        }
        div.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          showHighlightActionMenu(pageNumber, index, mark, div);
        });
        overlayDiv.appendChild(div);
      });
    }

    function addOverlayHighlights(page, rects) {
      const viewport = pageViewports.get(page);
      if (!rects?.length) {
        return;
      }
      if (!viewport) {
        const existingPending = pendingHighlightQueue.get(page) || [];
        pendingHighlightQueue.set(page, existingPending.concat(rects));
        return;
      }
      const existing = pageHighlightData.get(page) || [];
      const normalised = rects.map((rect) => {
        const baseRect = rect.width && rect.height ? rect : {
          ...rect,
          width: rect.x2 - rect.x1,
          height: rect.y2 - rect.y1,
        };
        const fingerprint = rect.fingerprint
          || [baseRect.x1, baseRect.y1, baseRect.x2, baseRect.y2].map((v) => Number(v).toFixed(2)).join(":");
        const normalizedRect = normaliseRect(baseRect, viewport);
        return {
          ...normalizedRect,
          color: resolveOverlayColor(rect.color, { highlightId: rect.highlightId || rect.highlight_id || null }),
          fingerprint,
          localId: rect.localId || rect.local_id || null,
          highlightId: rect.highlightId || rect.highlight_id || null,
        };
      });
      const merged = [...existing];
      normalised.forEach((mark) => {
        const matchIndex = merged.findIndex((existingMark) => {
          if (mark.highlightId && existingMark.highlightId && mark.highlightId === existingMark.highlightId) {
            return true;
          }
          if (mark.localId && existingMark.localId && mark.localId === existingMark.localId) {
            return Math.abs(existingMark.x1 - mark.x1) < 0.002 && Math.abs(existingMark.y1 - mark.y1) < 0.002;
          }
          if (mark.fingerprint && existingMark.fingerprint && mark.fingerprint === existingMark.fingerprint) {
            return true;
          }
          return false;
        });
        if (matchIndex >= 0) {
          merged[matchIndex] = { ...merged[matchIndex], ...mark };
        } else {
          merged.push(mark);
        }
      });
      pageHighlightData.set(page, merged);
      renderOverlayForPage(page);
    }

    function marksMatch(candidate, match = {}) {
      if (!candidate) {
        return false;
      }
      if (match.highlightId && candidate.highlightId === match.highlightId) {
        return true;
      }
      if (match.localId && candidate.localId === match.localId) {
        return true;
      }
      if (!match.highlightId && !match.localId && match.fingerprint && candidate.fingerprint === match.fingerprint) {
        return true;
      }
      return false;
    }

    function removeMarksMatching(page, match = {}) {
      const marks = pageHighlightData.get(page) || [];
      if (!marks.length) {
        return [];
      }
      const removedEntries = [];
      for (let idx = marks.length - 1; idx >= 0; idx -= 1) {
        const candidate = marks[idx];
        if (!marksMatch(candidate, match)) {
          continue;
        }
        const [removedMark] = marks.splice(idx, 1);
        removedEntries.push({
          mark: removedMark,
          index: idx,
        });
      }
      if (removedEntries.length) {
        pageHighlightData.set(page, marks);
        renderOverlayForPage(page);
      }
      return removedEntries.reverse();
    }

    function removeOverlayMarkByIndex(page, markIndex, { notify = true } = {}) {
      const marks = pageHighlightData.get(page) || [];
      if (markIndex < 0 || markIndex >= marks.length) {
        return null;
      }
      const [removed] = marks.splice(markIndex, 1);
      pageHighlightData.set(page, marks);
      renderOverlayForPage(page);
      if (notify) {
        safeSendMessage({
          type: "PDF_HIGHLIGHT_CANCELLED",
          payload: {
            url: originalUrl,
            page,
            fingerprint: removed?.fingerprint || null,
            highlight_id: removed?.highlightId || null,
            local_id: removed?.localId || null,
          },
        });
      }
      return removed;
    }

    function removeMarkByIdentifiers(page, identifiers = {}) {
      const { highlightId, localId, fingerprint } = identifiers;
      const removed = removeMarksMatching(page, { highlightId, localId, fingerprint });
      if (!removed.length) {
        return;
      }
      const targetMatch = removed.some((entry) => marksMatch(entry.mark, {
        highlightId: highlightActionTarget?.highlightId || null,
        localId: highlightActionTarget?.localId || null,
        fingerprint: highlightActionTarget?.fingerprint || null,
      }));
      if (
        highlightActionTarget
        && highlightActionTarget.page === page
        && (
          targetMatch
          || (typeof highlightActionTarget.markIndex === "number"
            && removed.some((entry) => entry.index === highlightActionTarget.markIndex))
        )
      ) {
        hideHighlightActionPopover();
      }
    }

    function ensureHighlightActionPopover() {
      if (highlightActionPopover && highlightActionPopover.isConnected) {
        return highlightActionPopover;
      }
      const menu = document.createElement("div");
      menu.className = "ea-highlight-menu";
      menu.hidden = true;
      menu.style.display = "none";
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "danger";
      removeBtn.textContent = "Remove highlight";
      removeBtn.addEventListener("click", () => {
        if (!highlightActionPopover || highlightActionPopover.hidden) {
          return;
        }
        const pageValue = Number(highlightActionPopover.dataset.eaTargetPage);
        const markValue = Number(highlightActionPopover.dataset.eaTargetIndex);
        if (Number.isFinite(pageValue) && Number.isFinite(markValue)) {
          requestOverlayRemoval(pageValue, markValue);
        }
      });
      menu.appendChild(removeBtn);
      document.body.appendChild(menu);
      highlightActionPopover = menu;
      return highlightActionPopover;
    }

    function showHighlightActionMenu(page, markIndex, mark, element) {
      const menu = ensureHighlightActionPopover();
      highlightActionTarget = {
        page,
        markIndex,
        element,
        highlightId: mark.highlightId || null,
        localId: mark.localId || null,
        fingerprint: mark.fingerprint || null,
      };
      menu.dataset.eaTargetPage = String(page);
      menu.dataset.eaTargetIndex = String(markIndex);
      menu.dataset.eaTargetLocalId = mark.localId || "";
      menu.dataset.eaTargetHighlightId = mark.highlightId || "";
      menu.dataset.eaTargetDocumentUrl = originalUrl;
      const rect = element.getBoundingClientRect();
      menu.style.left = `${window.scrollX + rect.left}px`;
      menu.style.top = `${window.scrollY + rect.bottom + 8}px`;
      menu.style.display = "flex";
      menu.hidden = false;
    }

    function hideHighlightActionPopover() {
      if (highlightActionPopover) {
        highlightActionPopover.hidden = true;
        highlightActionPopover.style.display = "none";
        delete highlightActionPopover.dataset.eaTargetPage;
        delete highlightActionPopover.dataset.eaTargetIndex;
        delete highlightActionPopover.dataset.eaTargetLocalId;
        delete highlightActionPopover.dataset.eaTargetHighlightId;
        delete highlightActionPopover.dataset.eaTargetDocumentUrl;
      }
      highlightActionTarget = null;
    }

    function requestOverlayRemoval(page, markIndex) {
      const marks = pageHighlightData.get(page) || [];
      const mark = marks[markIndex];
      const removedGroup = removeMarksMatching(page, {
        highlightId: mark?.highlightId || null,
        localId: mark?.localId || null,
        fingerprint: mark?.fingerprint || null,
      });
      if (!removedGroup.length) {
        hideHighlightActionPopover();
        return;
      }
      const identifiers = {
        highlight_id: mark?.highlightId || null,
        local_id: mark?.localId || null,
        fingerprint: mark?.fingerprint || null,
        url: originalUrl,
        page,
      };
      if (mark?.highlightId) {
        safeSendMessage({
          type: "CONTENT_HIGHLIGHT_REMOVE_REQUEST",
          payload: identifiers,
        });
      } else {
        safeSendMessage({
          type: "PDF_HIGHLIGHT_CANCELLED",
          payload: identifiers,
        });
      }
      hideHighlightActionPopover();
    }

    function flushPendingHighlights(page) {
      const pending = pendingHighlightQueue.get(page);
      if (!pending || !pending.length) {
        return;
      }
      pendingHighlightQueue.delete(page);
      addOverlayHighlights(page, pending);
    }

    async function ensureDocumentRecord({ forceRefresh = false } = {}) {
      if (!annotatorStorage || !annotatorApi) {
        throw new Error("Extension context unavailable");
      }
      const stored = await annotatorStorage.get([storageKeys.SESSION, storageKeys.DOCUMENTS]);
      const session = stored[storageKeys.SESSION];
      const documents = stored[storageKeys.DOCUMENTS] || {};
      if (!session || !session.session_id) {
        throw new Error("Start a session in the popup before completing this document.");
      }
      const sessionDocs = documents[session.session_id] || {};
      const existingEntry = sessionDocs[originalUrl] || null;
      if (existingEntry && !forceRefresh && existingEntry.document_id) {
        return {
          session,
          documents,
          entry: existingEntry,
        };
      }

      const payload = {
        title: existingEntry?.title || originalTitle || originalUrl,
        url: originalUrl,
        type: "pdf",
        accessed_at: existingEntry?.accessed_at || new Date().toISOString(),
      };
      const response = await annotatorApi.request(`/sessions/${session.session_id}/documents`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const mergedEntry = {
        document_id: response.document_id,
        title: response.title,
        accessed_at: response.accessed_at,
        type: response.type,
        global_judgment: response.global_judgment || existingEntry?.global_judgment || null,
        pdf_review: response.pdf_review || existingEntry?.pdf_review || null,
        highlights: Array.isArray(existingEntry?.highlights) ? existingEntry.highlights : [],
      };
      sessionDocs[originalUrl] = mergedEntry;
      documents[session.session_id] = sessionDocs;
      await annotatorStorage.set({
        [storageKeys.DOCUMENTS]: documents,
      });
      return {
        session,
        documents,
        entry: mergedEntry,
      };
    }

    document.addEventListener("click", (event) => {
      if (!highlightActionPopover || highlightActionPopover.hidden) {
        return;
      }
      if (highlightActionPopover.contains(event.target)) {
        return;
      }
      if (highlightActionTarget?.element && highlightActionTarget.element.contains(event.target)) {
        return;
      }
      hideHighlightActionPopover();
    }, true);

    window.addEventListener("scroll", () => {
      if (highlightActionPopover && !highlightActionPopover.hidden) {
        hideHighlightActionPopover();
      }
    }, true);

    chrome.runtime.onMessage.addListener((message) => {
      if (!message || !message.type) {
        return;
      }
      if (message.type === "PDF_HIGHLIGHT_CREATED") {
        if (message.payload?.url !== originalUrl) {
          return;
        }
        const { page, rects, highlight_id: highlightId, local_id: localId } = message.payload;
        if (!page) {
          return;
        }
        const rectPayloads = Array.isArray(rects) ? rects.map((rect) => ({
          ...rect,
          highlightId: highlightId || rect.highlightId || null,
          localId: localId || rect.localId || null,
          color: resolveOverlayColor(rect.color, { highlightId: highlightId || rect.highlightId || null }),
        })) : [];
        if (rectPayloads.length) {
          addOverlayHighlights(page, rectPayloads);
        }
      } else if (message.type === "PDF_HIGHLIGHT_CANCELLED") {
        if (message.payload?.url !== originalUrl) {
          return;
        }
        const { page, highlight_id: highlightId, local_id: localId, fingerprint } = message.payload || {};
        if (!page) {
          return;
        }
        removeMarkByIdentifiers(page, { highlightId, localId, fingerprint });
      }
    });

    async function openSummaryModal() {
      if (!annotatorApi || !annotatorStorage) {
        alert("Please reload the extension popup before completing the paper.");
        return;
      }

      const overlay = document.createElement("div");
      overlay.className = "summary-overlay";
      const modal = document.createElement("div");
      modal.className = "summary-modal summary-modal--wide";
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");
      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      function onKeydown(event) {
        if (event.key === "Escape") {
          event.preventDefault();
          closeModal();
        }
      }

      function closeModal() {
        document.removeEventListener("keydown", onKeydown);
        overlay.remove();
      }

      document.addEventListener("keydown", onKeydown);
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) {
          closeModal();
        }
      });

      const renderError = (message) => {
        modal.innerHTML = "";
        const title = document.createElement("h2");
        title.textContent = "Complete Paper";
        modal.appendChild(title);
        const errorText = document.createElement("p");
        errorText.className = "summary-error";
        errorText.textContent = message;
        modal.appendChild(errorText);
        const actions = document.createElement("div");
        actions.className = "modal-actions";
        const closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.className = "primary";
        closeBtn.textContent = "Close";
        closeBtn.addEventListener("click", closeModal);
        actions.appendChild(closeBtn);
        modal.appendChild(actions);
      };

      let context;
      try {
        context = await ensureDocumentRecord({ forceRefresh: true });
      } catch (error) {
        console.error("Unable to load document record", error);
        renderError(error.message || "Failed to load document details. Try again from the side panel.");
        return;
      }

      const { entry: baseEntry } = context;
      const review = baseEntry?.pdf_review || {};
      const summaryData = baseEntry?.global_judgment || {};
      const highlightOrder = Array.isArray(review.highlight_order) ? review.highlight_order : [];
      const sentimentDefault = normalisePdfSentimentValue(review.sentiment);
      const highlights = Array.isArray(baseEntry?.highlights) ? baseEntry.highlights.slice() : [];

      const orderMap = new Map();
      highlightOrder.forEach((id, index) => {
        if (!orderMap.has(id)) {
          orderMap.set(id, index);
        }
      });

      const orderedHighlights = highlights
        .map((highlight, index) => ({
          data: highlight,
          index,
          rank: highlight.highlight_id && orderMap.has(highlight.highlight_id)
            ? orderMap.get(highlight.highlight_id)
            : highlightOrder.length + index,
        }))
        .sort((a, b) => a.rank - b.rank)
        .map((entryItem) => entryItem.data);

      modal.innerHTML = "";
      const title = document.createElement("h2");
      title.textContent = "Complete Paper";
      modal.appendChild(title);

      const description = document.createElement("p");
      description.className = "summary-description";
      description.textContent = "Review your saved snippets, drag to rank them, then capture your summary.";
      modal.appendChild(description);

      const highlightSection = document.createElement("section");
      highlightSection.className = "summary-highlight-section";
      const highlightHeader = document.createElement("div");
      highlightHeader.className = "summary-highlight-header";
      highlightHeader.textContent = "Highlight order";
      highlightSection.appendChild(highlightHeader);

      const highlightList = document.createElement("ol");
      highlightList.className = "summary-highlight-list";

      const formatSnippet = (text) => {
        if (!text) {
          return "(empty snippet)";
        }
        const trimmed = text.trim();
        if (trimmed.length <= 260) {
          return trimmed;
        }
        return `${trimmed.slice(0, 257)}…`;
      };

      const draggableCount = orderedHighlights.reduce((count, highlight) => {
        if (highlight?.highlight_id) {
          return count + 1;
        }
        return count;
      }, 0);

      if (orderedHighlights.length === 0) {
        const emptyMessage = document.createElement("p");
        emptyMessage.className = "summary-highlight-empty";
        emptyMessage.textContent = "No saved highlights yet. Capture at least one snippet before completing.";
        highlightSection.appendChild(emptyMessage);
      } else {
        orderedHighlights.forEach((highlight) => {
          const item = document.createElement("li");
          item.className = "summary-highlight-item";
          const highlightId = highlight.highlight_id || null;
          if (highlightId) {
            item.dataset.highlightId = highlightId;
            item.draggable = true;
          } else {
            item.classList.add("summary-highlight-item--disabled");
          }

          const handle = document.createElement("span");
          handle.className = "summary-highlight-handle";
          handle.setAttribute("aria-hidden", "true");
          handle.textContent = "⋮⋮";
          item.appendChild(handle);

          const body = document.createElement("div");
          body.className = "summary-highlight-body";

          const snippet = document.createElement("p");
          snippet.className = "summary-highlight-text";
          snippet.textContent = formatSnippet(highlight.text);
          body.appendChild(snippet);

          const meta = document.createElement("span");
          meta.className = "summary-highlight-meta";
          const pageNumber = highlight.selector?.page || highlight.page || null;
          if (pageNumber) {
            meta.textContent = `Page ${pageNumber}`;
          } else if (highlightId) {
            meta.textContent = "Saved highlight";
          } else {
            meta.textContent = "Unsaved highlight";
          }
          body.appendChild(meta);

          item.appendChild(body);
          highlightList.appendChild(item);
        });

        if (draggableCount > 1) {
          let draggedItem = null;
          highlightList.addEventListener("dragstart", (event) => {
            const item = event.target.closest(".summary-highlight-item");
            if (!item || !item.dataset.highlightId) {
              event.preventDefault();
              return;
            }
            draggedItem = item;
            item.classList.add("dragging");
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", item.dataset.highlightId);
          });
          highlightList.addEventListener("dragend", () => {
            if (draggedItem) {
              draggedItem.classList.remove("dragging");
              draggedItem = null;
            }
          });
          highlightList.addEventListener("dragover", (event) => {
            if (!draggedItem) {
              return;
            }
            event.preventDefault();
            const target = event.target.closest(".summary-highlight-item");
            if (!target || target === draggedItem || !target.dataset.highlightId) {
              return;
            }
            const targetRect = target.getBoundingClientRect();
            const offset = event.clientY - targetRect.top;
            const shouldInsertAfter = offset > targetRect.height / 2;
            if (shouldInsertAfter) {
              highlightList.insertBefore(draggedItem, target.nextSibling);
            } else {
              highlightList.insertBefore(draggedItem, target);
            }
          });
        } else {
          highlightList.classList.add("summary-highlight-list--static");
        }

        highlightSection.appendChild(highlightList);
        const highlightHint = document.createElement("p");
        highlightHint.className = "summary-highlight-hint";
        highlightHint.textContent =
          draggableCount > 1
            ? "Drag and drop to reflect importance (top = highest)."
            : "Captured highlights will appear here for ranking.";
        highlightSection.appendChild(highlightHint);
      }

      modal.appendChild(highlightSection);

      const sentimentField = document.createElement("label");
      sentimentField.className = "summary-field";
      const sentimentLabel = document.createElement("span");
      sentimentLabel.className = "summary-label";
      sentimentLabel.textContent = "Overall sentiment";
      sentimentField.appendChild(sentimentLabel);
      const sentimentSelect = document.createElement("select");
      sentimentSelect.className = "summary-sentiment";
      PDF_REVIEW_SENTIMENTS.forEach((option) => {
        const opt = document.createElement("option");
        opt.value = option.value;
        opt.textContent = option.label;
        sentimentSelect.appendChild(opt);
      });
      sentimentSelect.value = sentimentDefault;
      sentimentField.appendChild(sentimentSelect);
      modal.appendChild(sentimentField);

      const finalField = document.createElement("label");
      finalField.className = "summary-field";
      const finalLabel = document.createElement("span");
      finalLabel.className = "summary-label";
      finalLabel.textContent = "Final thoughts";
      finalField.appendChild(finalLabel);
      const finalInput = document.createElement("textarea");
      finalInput.className = "summary-final";
      finalInput.placeholder = "Summarize your insights from this paper";
      finalInput.value = summaryData.final_thoughts || "";
      finalField.appendChild(finalInput);
      modal.appendChild(finalField);

      const nextField = document.createElement("label");
      nextField.className = "summary-field";
      const nextLabel = document.createElement("span");
      nextLabel.className = "summary-label";
      nextLabel.textContent = "Next steps / decision";
      nextField.appendChild(nextLabel);
      const nextInput = document.createElement("textarea");
      nextInput.className = "summary-next";
      nextInput.placeholder = "What will you do next based on this paper?";
      nextInput.value = summaryData.next_steps || "";
      nextField.appendChild(nextInput);
      modal.appendChild(nextField);

      const actions = document.createElement("div");
      actions.className = "modal-actions";
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "secondary";
      cancelBtn.id = "summary-cancel";
      cancelBtn.textContent = "Cancel";
      cancelBtn.addEventListener("click", closeModal);
      const saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "primary";
      saveBtn.id = "summary-save";
      saveBtn.textContent = "Save summary";
      actions.appendChild(cancelBtn);
      actions.appendChild(saveBtn);
      modal.appendChild(actions);

      const focusTarget = finalInput;
      setTimeout(() => {
        focusTarget.focus();
      }, 50);

      const getHighlightOrder = () => {
        if (!highlightList || highlightList.children.length === 0) {
          return [];
        }
        const ids = Array.from(highlightList.querySelectorAll(".summary-highlight-item[data-highlight-id]"))
          .map((item) => String(item.dataset.highlightId || "").trim())
          .filter((value) => value.length > 0);
        const uniqueOrder = [];
        const seen = new Set();
        ids.forEach((id) => {
          if (!seen.has(id)) {
            seen.add(id);
            uniqueOrder.push(id);
          }
        });
        return uniqueOrder;
      };

      const reorderHighlights = (list, order) => {
        if (!Array.isArray(list) || !list.length) {
          return list || [];
        }
        if (!order || order.length === 0) {
          return list;
        }
        const map = new Map();
        list.forEach((item) => {
          if (item?.highlight_id) {
            map.set(item.highlight_id, item);
          }
        });
        const ordered = [];
        const used = new Set();
        order.forEach((id) => {
          if (map.has(id) && !used.has(id)) {
            ordered.push(map.get(id));
            used.add(id);
          }
        });
        list.forEach((item) => {
          const id = item?.highlight_id;
          if (!id || !used.has(id)) {
            ordered.push(item);
          }
        });
        return ordered;
      };

      saveBtn.addEventListener("click", async () => {
        const finalThoughts = finalInput.value.trim();
        if (!finalThoughts) {
          finalInput.focus();
          return;
        }
        const highlightIds = getHighlightOrder();
        saveBtn.disabled = true;
        saveBtn.textContent = "Saving…";
        try {
          const latestContext = await ensureDocumentRecord({ forceRefresh: true });
          const { session: latestSession, documents: latestDocuments, entry: latestEntry } = latestContext;
          if (!latestSession?.session_id) {
            throw new Error("Start a session before completing the paper.");
          }
          if (!latestEntry?.document_id) {
            throw new Error("Unable to locate the document record. Re-open the PDF viewer from the side panel and try again.");
          }
          const sessionDocs = latestDocuments[latestSession.session_id] || {};
          const reviewResponse = await annotatorApi.request(
            `/sessions/${latestSession.session_id}/documents/${latestEntry.document_id}/pdf-review`,
            {
              method: "POST",
              body: JSON.stringify({
                sentiment: sentimentSelect.value,
                highlight_order: highlightIds,
              }),
            }
          );
          const resolvedDocumentId = reviewResponse?.document_id || latestEntry.document_id;
          latestEntry.document_id = resolvedDocumentId;
          sessionDocs[originalUrl] = latestEntry;
          latestDocuments[latestSession.session_id] = sessionDocs;
          const refreshedContext = await ensureDocumentRecord({ forceRefresh: true });
          const refreshedEntry = refreshedContext?.entry || latestEntry;
          const documentIdForSummary = refreshedEntry?.document_id || resolvedDocumentId;
          if (!documentIdForSummary) {
            throw new Error("Unable to resolve document identifier for summary.");
          }
          const summaryResponse = await annotatorApi.request(
            `/sessions/${latestSession.session_id}/documents/${documentIdForSummary}/summary`,
            {
              method: "POST",
              body: JSON.stringify({
                final_thoughts: finalThoughts,
                next_steps: nextInput.value.trim() || null,
              }),
            }
          );
          const mergedEntry = {
            ...latestEntry,
            document_id: documentIdForSummary,
            pdf_review: reviewResponse,
            global_judgment: summaryResponse.global_judgment,
            highlights: reorderHighlights(refreshedEntry?.highlights || latestEntry.highlights || [], reviewResponse.highlight_order),
          };
          sessionDocs[originalUrl] = mergedEntry;
          latestDocuments[latestSession.session_id] = sessionDocs;
          await annotatorStorage.set({
            [storageKeys.DOCUMENTS]: latestDocuments,
          });
          chrome.runtime.sendMessage({
            type: "PDF_REVIEW_SAVED",
            payload: {
              url: originalUrl,
              document_id: documentIdForSummary,
              sentiment: reviewResponse.sentiment,
              highlight_order: reviewResponse.highlight_order,
            },
          });
          chrome.runtime.sendMessage({
            type: "DOCUMENT_SUMMARY_SAVED",
            payload: {
              url: originalUrl,
              global_judgment: summaryResponse.global_judgment,
            },
          });
          closeModal();
          alert("Summary and highlight order saved.");
        } catch (error) {
          console.error("Failed to save summary", error);
          saveBtn.disabled = false;
          saveBtn.textContent = "Save summary";
          alert(error.message || "Failed to save summary.");
        }
      });
    }
  })();
}
    
