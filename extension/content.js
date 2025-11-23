/* global chrome */

(() => {
  const MAX_CONTEXT_CHARS = 30;
  const MAX_CONTEXT_BLOCK_CHARS = 420;
  let lastSelectionSignature = null;
  let lastSearchSignature = null;
  let selectionPopover = null;
  let pendingSelection = null;
  let stylesInjected = false;
  let pointerDown = false;

  const DEBUG_ENABLED = (() => {
    try {
      if (typeof window !== "undefined" && window.EA_DEBUG === true) {
        return true;
      }
      const stored = window.localStorage?.getItem("EA_DEBUG");
      return stored === "true";
    } catch (error) {
      return false;
    }
  })();

  function debugLog(...args) {
    if (DEBUG_ENABLED) {
      console.debug("Expert Annotator (debug):", ...args);
    }
  }

  try {
    window.__EA_DEBUG_ENABLED = DEBUG_ENABLED;
    window.__EA_CONTENT_VERSION = "0.3.0-html";
    window.__EA_PENDING_SELECTION = null;
  } catch (error) {
    // Ignore exposure errors (e.g., restricted window access).
  }

  const SENTIMENT_OPTIONS = [
    { value: "thumbsup", label: "Thumbs up" },
    { value: "thumbsdown", label: "Thumbs down" },
  ];

  let lastSentimentChoice = SENTIMENT_OPTIONS[0].value;

  const HIGHLIGHT_CLASS = "ea-highlight";
  const SENTIMENT_CLASS_MAP = {
    thumbsup: "ea-highlight--thumbsup",
    thumbsdown: "ea-highlight--thumbsdown",
    neutral_information: "ea-highlight--neutral",
  };

  const highlightRegistry = new Map(); // localId -> { element, sentiment, highlightId, documentUrl, selector, text }
  let highlightActionPopover = null;
  let highlightActionTarget = null;

  const SENTIMENT_ICON_FILES = {
    thumbsup: "assets/thumb-up.png",
    thumbsdown: "assets/thumb-down.png",
  };

  function resolveAssetUrl(relativePath) {
    if (!relativePath) {
      return relativePath;
    }
    try {
      if (chrome?.runtime?.getURL) {
        return chrome.runtime.getURL(relativePath);
      }
    } catch (error) {
      debugLog("Failed to resolve asset URL via runtime", error);
    }
    return relativePath;
  }

  function getSentimentIconUrl(type) {
    const file = SENTIMENT_ICON_FILES[type] || SENTIMENT_ICON_FILES.thumbsup;
    return resolveAssetUrl(file);
  }

  function createSentimentIcon(type, label) {
    const img = document.createElement("img");
    img.className = "ea-sentiment-button__icon";
    img.src = getSentimentIconUrl(type);
    img.alt = label || type;
    img.setAttribute("draggable", "false");
    return img;
  }

  function ensureSentimentOption(value) {
    if (value && SENTIMENT_OPTIONS.some((option) => option.value === value)) {
      return value;
    }
    return SENTIMENT_OPTIONS[0].value;
  }

  function setPopoverSentiment(popoverEl, value, { syncPending = false } = {}) {
    if (!popoverEl) {
      return;
    }
    const normalized = ensureSentimentOption(value);
    const buttons = popoverEl.querySelectorAll(".ea-sentiment-button");
    buttons.forEach((button) => {
      const isActive = button.dataset.value === normalized;
      button.classList.toggle("is-selected", isActive);
      button.setAttribute("aria-pressed", isActive ? "true" : "false");
    });
    popoverEl.dataset.eaSentimentValue = normalized;
    if (syncPending && pendingSelection) {
      pendingSelection.sentiment = normalized;
    }
  }

  function publishPendingSelection() {
    if (!DEBUG_ENABLED) {
      return;
    }
    try {
      window.__EA_PENDING_SELECTION = pendingSelection
        ? {
            text: pendingSelection.text,
            sentiment: pendingSelection.sentiment,
            context: pendingSelection.context,
            contextLength: pendingSelection.context?.length || 0,
            meta: pendingSelection.meta,
            hasRange: Boolean(pendingSelection.range),
          }
        : null;
    } catch (error) {
      debugLog("Unable to expose pending selection", error);
    }
  }

  function safeSendMessage(message, retries = 1) {
    if (!chrome.runtime || !chrome.runtime.id || typeof chrome.runtime.sendMessage !== "function") {
      console.debug("Expert Annotator: runtime unavailable, skipping message", message?.type);
      return;
    }
    try {
      chrome.runtime.sendMessage(message, () => {
        if (chrome.runtime.lastError) {
          const errMsg = chrome.runtime.lastError.message || "unknown";
          console.debug("Expert Annotator: message failed", message?.type, errMsg);
          if (retries > 0 && errMsg.includes("Extension context invalidated")) {
            setTimeout(() => safeSendMessage(message, retries - 1), 200);
          }
        }
      });
    } catch (error) {
      console.debug("Expert Annotator: message error", message?.type, error);
    }
  }

  const SEARCH_PLATFORMS = [
    {
      name: "google_scholar",
      matcher: /(^|\.)scholar\.google\./i,
      extract: (url) => url.searchParams.get("q"),
    },
    {
      name: "semantic_scholar",
      matcher: /(^|\.)semanticscholar\.org$/i,
      extract: (url) => {
        if (url.searchParams.get("q")) {
          return url.searchParams.get("q");
        }
        const segments = url.pathname.split("/").filter(Boolean);
        const searchIndex = segments.indexOf("search");
        if (searchIndex !== -1 && segments[searchIndex + 1]) {
          return decodeURIComponent(segments[searchIndex + 1]);
        }
        return null;
      },
    },
  ];

  if (window.location.protocol === "chrome-extension:") {
    // Avoid running inside extension pages such as the PDF viewer itself.
    return;
  }

  function normalizeWhitespace(text) {
    return text.replace(/\s+/g, " ").trim();
  }

  function extractContext(range, direction) {
    debugLog("Extracting context slice", direction);
    try {
      const contextRange = range.cloneRange();
      if (direction === "prefix") {
        contextRange.collapse(true);
        contextRange.setStart(document.body, 0);
        const raw = contextRange.toString();
        return normalizeWhitespace(raw.slice(-MAX_CONTEXT_CHARS));
      }
      contextRange.collapse(false);
      contextRange.setEnd(document.body, document.body.childNodes.length);
      const raw = contextRange.toString();
      return normalizeWhitespace(raw.slice(0, MAX_CONTEXT_CHARS));
    } catch (error) {
      debugLog("Context extraction failed", error);
      return "";
    }
  }

  function buildTextQuoteSelector(range, text) {
    return {
      type: "TextQuote",
      exact: text,
      prefix: extractContext(range, "prefix"),
      suffix: extractContext(range, "suffix"),
    };
  }

  function isPdfViewerPage() {
    return (
      location.hostname.includes("mozilla.github.io") &&
      location.pathname.includes("/pdf.js/web/viewer.html")
    );
  }

  function attachHighlightInteractions(element) {
    element.addEventListener(
      "click",
      (event) => {
        event.preventDefault();
        event.stopPropagation();
        highlightActionTarget = element;
        hideSelectionPopover();
        positionHighlightActionPopover(element);
      },
      true
    );
  }

  function getPdfSourceUrl() {
    if (!isPdfViewerPage()) {
      return null;
    }
    const params = new URLSearchParams(window.location.search);
    const fileParam = params.get("file");
    return fileParam ? decodeURIComponent(fileParam) : null;
  }

  function buildPdfSelector(range, text) {
    const container =
      range.commonAncestorContainer instanceof Element
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
    if (!container) {
      return null;
    }
    const pageEl = container.closest && container.closest(".page");
    if (!pageEl) {
      return null;
    }
    const pageNumber = Number(
      pageEl.getAttribute("data-page-number") || pageEl.dataset.pageNumber
    );
    if (!pageNumber) {
      return null;
    }
    const selectionRect = range.getBoundingClientRect();
    const pageRect = pageEl.getBoundingClientRect();
    const coords = {
      x1: Number((selectionRect.left - pageRect.left).toFixed(2)),
      y1: Number((selectionRect.top - pageRect.top).toFixed(2)),
      x2: Number((selectionRect.right - pageRect.left).toFixed(2)),
      y2: Number((selectionRect.bottom - pageRect.top).toFixed(2)),
    };
    return {
      type: "PDFText",
      page: pageNumber,
      text,
      coords,
    };
  }

  function ensureStyles() {
    if (stylesInjected) {
      return;
    }
    debugLog("Injecting content styles");
    stylesInjected = true;
    const style = document.createElement("style");
    style.id = "__ea_content_styles__";
    const styleTarget = document.head || document.documentElement;
    const styleText = `
.${HIGHLIGHT_CLASS} {
  display: inline;
  background: rgba(251, 243, 219, 0.95);
  border-radius: 2px;
  padding: 0 2px;
  box-shadow: inset 0 0 0 1px rgba(60, 64, 67, 0.25);
  transition: box-shadow 0.2s ease-in-out;
}
.${SENTIMENT_CLASS_MAP.thumbsup} {
  background: rgba(198, 239, 206, 0.9);
}
.${SENTIMENT_CLASS_MAP.thumbsdown} {
  background: rgba(252, 214, 214, 0.9);
}
.${SENTIMENT_CLASS_MAP.neutral_information} {
  background: rgba(225, 239, 255, 0.9);
}
.${HIGHLIGHT_CLASS}:hover {
  box-shadow: inset 0 0 0 2px rgba(26, 115, 232, 0.35);
}
.ea-popover {
  position: absolute;
  z-index: 2147483647;
  background: #ffffff;
  border: 1px solid rgba(60, 64, 67, 0.25);
  border-radius: 8px;
  padding: 10px;
  box-shadow: 0 8px 24px rgba(60, 64, 67, 0.18);
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 13px;
  color: #202124;
  min-width: 200px;
  background-clip: padding-box;
}
.ea-popover[hidden] {
  display: none !important;
}
.ea-popover__label {
  display: grid;
  gap: 4px;
  margin-bottom: 8px;
}
.ea-popover__label span {
  font-weight: 600;
}
.ea-sentiment-buttons {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.35rem;
}
.ea-sentiment-button {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  border: none;
  background: transparent;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: transform 0.15s ease, box-shadow 0.15s ease;
  padding: 0;
}
.ea-sentiment-button:focus-visible {
  outline: 2px solid #1a73e8;
  outline-offset: 2px;
}
.ea-sentiment-button.is-selected {
  box-shadow: 0 0 0 3px rgba(26, 115, 232, 0.35);
  transform: translateY(-1px);
}
.ea-sentiment-button__icon {
  width: 44px;
  height: 44px;
}
.ea-popover__actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}
.ea-popover button {
  cursor: pointer;
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 12px;
  border: 1px solid rgba(60, 64, 67, 0.12);
  background: #f1f3f4;
  color: #202124;
}
.ea-popover__save {
  background: #1a73e8;
  color: #ffffff;
  border-color: #1a73e8;
}
.ea-popover__save:hover {
  background: #1666c1;
  border-color: #1666c1;
}
.ea-popover__cancel:hover {
  background: #e8eaed;
}
.ea-highlight-menu {
  position: absolute;
  z-index: 2147483647;
  background: #ffffff;
  border: 1px solid rgba(60, 64, 67, 0.25);
  border-radius: 8px;
  padding: 6px 8px;
  box-shadow: 0 8px 24px rgba(60, 64, 67, 0.18);
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 12px;
  color: #202124;
  display: flex;
  gap: 6px;
  align-items: center;
}
.ea-highlight-menu button {
  border: 1px solid rgba(60, 64, 67, 0.2);
  background: #f8f9fa;
  color: #3c4043;
  border-radius: 6px;
  padding: 4px 8px;
  cursor: pointer;
  font-size: 12px;
}
.ea-highlight-menu button:hover {
  background: #e8eaed;
}
.ea-highlight-menu button.danger {
  border-color: rgba(234, 67, 53, 0.25);
  color: #a50e0e;
  background: rgba(234, 67, 53, 0.1);
}
.ea-highlight-menu button.danger:hover {
  background: rgba(234, 67, 53, 0.18);
}
`;
    style.textContent = styleText;
    styleTarget.appendChild(style);
  }

  function setHighlightSentiment(element, sentiment) {
    if (!element) {
      return;
    }
    debugLog("Applying sentiment classes", sentiment);
    element.classList.add(HIGHLIGHT_CLASS);
    Object.values(SENTIMENT_CLASS_MAP).forEach((className) => {
      element.classList.remove(className);
    });
    const className = SENTIMENT_CLASS_MAP[sentiment];
    if (className) {
      element.classList.add(className);
    }
    element.dataset.eaSentiment = sentiment;
  }

  function applyHighlightToRange(range, sentiment) {
    if (!range || range.collapsed) {
      debugLog("Highlight wrap skipped: invalid range");
      return null;
    }
    try {
      const wrapper = document.createElement("span");
      setHighlightSentiment(wrapper, sentiment);
      wrapper.dataset.eaHighlight = "pending";
      const contents = range.extractContents();
      wrapper.appendChild(contents);
      range.insertNode(wrapper);
      wrapper.normalize();
      debugLog("Highlight wrapper inserted");
      return wrapper;
    } catch (error) {
      console.debug("Expert Annotator: unable to highlight selection", error);
      debugLog("Highlight wrap failed", error);
      return null;
    }
  }

  function ensurePopover() {
    ensureStyles();
    if (selectionPopover && selectionPopover.isConnected) {
      debugLog("Reusing existing popover");
      return selectionPopover;
    }
    const popoverEl = document.createElement("div");
    popoverEl.className = "ea-popover";
    popoverEl.hidden = true;
    popoverEl.setAttribute("role", "dialog");

    const label = document.createElement("label");
    label.className = "ea-popover__label";
    const labelText = document.createElement("span");
    labelText.textContent = "Tag selection";
    const buttonGroup = document.createElement("div");
    buttonGroup.className = "ea-sentiment-buttons";
    buttonGroup.setAttribute("role", "group");
    buttonGroup.setAttribute("aria-label", "Choose sentiment");
    SENTIMENT_OPTIONS.forEach((option) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ea-sentiment-button";
      btn.dataset.value = option.value;
      btn.title = option.label;
      btn.setAttribute("aria-label", option.label);
      btn.setAttribute("aria-pressed", "false");
      btn.appendChild(createSentimentIcon(option.value, option.label));
      btn.addEventListener("click", () => {
        if (!pendingSelection) {
          return;
        }
        setPopoverSentiment(popoverEl, option.value, { syncPending: true });
      });
      buttonGroup.appendChild(btn);
    });
    label.appendChild(labelText);
    label.appendChild(buttonGroup);

    const actions = document.createElement("div");
    actions.className = "ea-popover__actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "ea-popover__cancel";
    cancelBtn.textContent = "Cancel";
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "ea-popover__save";
    saveBtn.textContent = "Save";
    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);

    popoverEl.appendChild(label);
    popoverEl.appendChild(actions);
    document.body.appendChild(popoverEl);

    saveBtn.addEventListener("click", () => {
      if (!pendingSelection) {
        hideSelectionPopover();
        return;
      }
      const sentimentChoice = ensureSentimentOption(pendingSelection.sentiment);
      debugLog("Popover save clicked", {
        sentiment: sentimentChoice,
        text: pendingSelection?.text?.slice?.(0, 120),
      });
      commitPendingSelection(sentimentChoice);
    });

    cancelBtn.addEventListener("click", () => {
      debugLog("Popover cancel clicked");
      clearPendingSelection();
    });

    setPopoverSentiment(popoverEl, SENTIMENT_OPTIONS[0].value);
    selectionPopover = popoverEl;
    debugLog("Popover created");
    return selectionPopover;
  }

  function positionPopover(rect) {
    if (!rect) {
      debugLog("Popover positioning skipped: no rect");
      return;
    }
    const popoverEl = ensurePopover();
    const desiredValue = ensureSentimentOption(pendingSelection?.sentiment || lastSentimentChoice);
    setPopoverSentiment(popoverEl, desiredValue, { syncPending: true });
    popoverEl.style.visibility = "hidden";
    popoverEl.hidden = false;
    popoverEl.style.top = "0px";
    popoverEl.style.left = "0px";
    const viewportPadding = 16;
    const popoverWidth = popoverEl.offsetWidth || 220;
    const popoverHeight = popoverEl.offsetHeight || 80;
    let left = window.scrollX + rect.left;
    let top = window.scrollY + rect.bottom + 8;
    if (left + popoverWidth + viewportPadding > window.scrollX + window.innerWidth) {
      left = window.scrollX + window.innerWidth - popoverWidth - viewportPadding;
    }
    if (left < window.scrollX + viewportPadding) {
      left = window.scrollX + viewportPadding;
    }
    if (top + popoverHeight + viewportPadding > window.scrollY + window.innerHeight) {
      top = Math.max(window.scrollY + rect.top - popoverHeight - 8, window.scrollY + viewportPadding);
    }
    popoverEl.style.left = `${left}px`;
    popoverEl.style.top = `${top}px`;
    popoverEl.style.visibility = "visible";
    debugLog("Popover positioned", { left, top, rect });
    const focusTarget =
      popoverEl.querySelector(".ea-sentiment-button.is-selected")
      || popoverEl.querySelector(".ea-sentiment-button");
    if (focusTarget && typeof focusTarget.focus === "function") {
      try {
        focusTarget.focus({ preventScroll: true });
      } catch (error) {
        focusTarget.focus();
      }
    }
  }

  function hideSelectionPopover() {
    if (selectionPopover) {
      selectionPopover.hidden = true;
      debugLog("Popover hidden");
    }
  }

  function ensureHighlightActionPopover() {
    if (highlightActionPopover && highlightActionPopover.isConnected) {
      return highlightActionPopover;
    }
    const menu = document.createElement("div");
    menu.className = "ea-highlight-menu";
    menu.hidden = true;
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "danger";
    removeBtn.textContent = "Remove highlight";
    removeBtn.addEventListener("click", () => {
      let targetElement = highlightActionTarget;
      if (!targetElement && highlightActionPopover?.dataset?.eaTargetLocalId) {
        targetElement = document.querySelector(
          `[data-ea-local-id="${highlightActionPopover.dataset.eaTargetLocalId}"]`
        );
      }
      if (!targetElement && highlightActionPopover?.dataset?.eaTargetHighlightId) {
        targetElement = document.querySelector(
          `[data-ea-highlight-id="${highlightActionPopover.dataset.eaTargetHighlightId}"]`
        );
      }
      if (targetElement) {
        debugLog("Remove button invoked", { localId: targetElement.dataset?.eaLocalId, highlightId: targetElement.dataset?.eaHighlightId });
        requestHighlightRemoval(targetElement);
      } else {
        debugLog("Remove button invoked but no target element found");
      }
    });
    menu.appendChild(removeBtn);
    document.body.appendChild(menu);
    highlightActionPopover = menu;
    return highlightActionPopover;
  }

  function hideHighlightActionPopover() {
    if (highlightActionPopover) {
      highlightActionPopover.hidden = true;
      delete highlightActionPopover.dataset.eaTargetLocalId;
      delete highlightActionPopover.dataset.eaTargetHighlightId;
      delete highlightActionPopover.dataset.eaTargetDocumentUrl;
    }
    highlightActionTarget = null;
  }

  function positionHighlightActionPopover(target) {
    const menu = ensureHighlightActionPopover();
    if (!target) {
      hideHighlightActionPopover();
      return;
    }
    const rect = target.getBoundingClientRect();
    const left = window.scrollX + rect.left;
    const top = window.scrollY + rect.bottom + 6;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.dataset.eaTargetLocalId = target.dataset.eaLocalId || "";
    menu.dataset.eaTargetHighlightId = target.dataset.eaHighlightId || "";
    menu.dataset.eaTargetDocumentUrl = target.dataset.eaDocumentUrl || "";
    menu.hidden = false;
  }

  function unwrapHighlightElement(element) {
    if (!element || !element.parentNode) {
      return;
    }
    const parent = element.parentNode;
    while (element.firstChild) {
      parent.insertBefore(element.firstChild, element);
    }
    parent.removeChild(element);
  }

  function escapeAttributeValue(value) {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      return CSS.escape(value);
    }
    return String(value).replace(/"/g, '\\"');
  }

  function unwrapHighlightsByIdentifiers({ localId = null, highlightId = null } = {}) {
    const matches = [];
    const seen = new Set();
    const selectors = [];
    if (localId) {
      selectors.push(`[data-ea-local-id="${escapeAttributeValue(localId)}"]`);
    }
    if (highlightId) {
      selectors.push(`[data-ea-highlight-id="${escapeAttributeValue(highlightId)}"]`);
    }
    selectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((node) => {
        if (node && !seen.has(node)) {
          matches.push(node);
          seen.add(node);
        }
      });
    });
    matches.forEach((node) => {
      unwrapHighlightElement(node);
    });
  }

  function requestHighlightRemoval(target) {
    const menuLocalId = highlightActionPopover?.dataset?.eaTargetLocalId || null;
    const menuHighlightId = highlightActionPopover?.dataset?.eaTargetHighlightId || null;
    const menuDocumentUrl = highlightActionPopover?.dataset?.eaTargetDocumentUrl || null;
    hideHighlightActionPopover();
    const candidateLocalId = target?.dataset?.eaLocalId || menuLocalId || null;
    const candidateHighlightId = target?.dataset?.eaHighlightId || menuHighlightId || null;
    const documentUrl = target?.dataset?.eaDocumentUrl || menuDocumentUrl || window.location.href;

    let element = target && target.classList && target.classList.contains(HIGHLIGHT_CLASS)
      ? target
      : target?.closest
        ? target.closest(`.${HIGHLIGHT_CLASS}`)
        : null;
    if (!element && candidateLocalId) {
      element = document.querySelector(`[data-ea-local-id="${candidateLocalId}"]`);
    }
    if (!element && candidateHighlightId) {
      element = document.querySelector(`[data-ea-highlight-id="${candidateHighlightId}"]`);
    }

    const localId = element?.dataset?.eaLocalId || candidateLocalId || null;
    const highlightId = element?.dataset?.eaHighlightId || candidateHighlightId || null;
    let registryEntry = localId && highlightRegistry.has(localId) ? highlightRegistry.get(localId) : null;
    if (!registryEntry && highlightId) {
      for (const [key, entry] of highlightRegistry.entries()) {
        if (entry.highlightId && entry.highlightId === highlightId) {
          registryEntry = entry;
          break;
        }
      }
    }
    if (!element && registryEntry?.element) {
      element = registryEntry.element;
    }
    debugLog("Removing highlight", { localId, highlightId, hasElement: Boolean(element) });

    if (element) {
      debugLog("Unwrapping highlight element", { text: element.textContent?.slice?.(0, 160) });
      unwrapHighlightElement(element);
    } else {
      unwrapHighlightsByIdentifiers({ localId, highlightId });
      debugLog("No highlight element matched for removal");
    }

    if (localId && highlightRegistry.has(localId)) {
      highlightRegistry.delete(localId);
    } else if (!localId && registryEntry) {
      for (const [key, entry] of highlightRegistry.entries()) {
        if (entry === registryEntry) {
          highlightRegistry.delete(key);
          break;
        }
      }
    }

    safeSendMessage(
      {
        type: "CONTENT_HIGHLIGHT_REMOVE_REQUEST",
        payload: {
          local_id: localId,
          highlight_id: highlightId,
          document_url: documentUrl,
        },
      },
      2
    );
    highlightActionTarget = null;
  }

  function clearPendingSelection() {
    if (pendingSelection) {
      debugLog("Clearing pending selection", {
        text: pendingSelection.text?.slice?.(0, 120),
        sentiment: pendingSelection.sentiment,
      });
    }
    pendingSelection = null;
    hideSelectionPopover();
    lastSelectionSignature = null;
    publishPendingSelection();
  }

  function cleanTextFromNode(node) {
    if (!node) {
      return "";
    }
    const clone = node.cloneNode(true);
    if (clone.querySelectorAll) {
      clone.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach((el) => {
        el.replaceWith(el.textContent || "");
      });
    }
    return normalizeWhitespace(clone.textContent || "");
  }

  function extractContextFromRange(range) {
    debugLog("Extracting context block");
    try {
      const host = window.location.hostname.toLowerCase();
      let contextNode = range?.commonAncestorContainer;
      if (contextNode && contextNode.nodeType === Node.TEXT_NODE) {
        contextNode = contextNode.parentElement;
      }
      if (!(contextNode instanceof Element)) {
        contextNode = document.body;
      }

      const candidateSelectors = host.includes("arxiv.org")
        ? [
            "li.arxiv-result",
            ".arxiv-result",
            "div.leftcolumn",
            "div#abs-content",
            "div#abs",
            "div#content-inner",
            "div#content",
            "div.abstract",
            "dl",
            "dd",
            "dt",
          ]
        : [];
      const fallbackSelectors = ["article", "[role='main']", "main", "section", "div", "p", "li"];

      const matchesSelector = (element, selector) => {
        try {
          return element.matches && element.matches(selector);
        } catch (error) {
          return false;
        }
      };

      let probe = contextNode;
      let selectedRoot = null;
      while (probe && probe !== document.body) {
        const candidateMatch = candidateSelectors.some((selector) => matchesSelector(probe, selector));
        if (candidateMatch) {
          selectedRoot = probe;
          break;
        }
        if (!selectedRoot && fallbackSelectors.some((selector) => matchesSelector(probe, selector))) {
          selectedRoot = probe;
        }
        probe = probe.parentElement;
      }
      if (!selectedRoot) {
        selectedRoot =
          document.querySelector("article") ||
          document.querySelector("[role='main']") ||
          document.querySelector("main") ||
          document.body;
      }

      const text = cleanTextFromNode(selectedRoot);
      const sliced = text.slice(0, MAX_CONTEXT_BLOCK_CHARS);
      debugLog("Context extracted", { length: sliced.length, selector: selectedRoot?.tagName });
      return sliced;
    } catch (error) {
      debugLog("Context extraction error", error);
      return "";
    }
  }

  function commitPendingSelection(sentiment) {
    if (!pendingSelection) {
      debugLog("Commit skipped: no pending selection");
      return;
    }
    const normalizedSentiment = ensureSentimentOption(
      sentiment || pendingSelection.sentiment || lastSentimentChoice
    );
    pendingSelection.sentiment = normalizedSentiment;
    const highlightEl = applyHighlightToRange(pendingSelection.range, normalizedSentiment);
    let localId = null;
    if (highlightEl) {
      localId = `ea-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      highlightEl.dataset.eaContext = pendingSelection.context || "";
      highlightEl.dataset.eaSentiment = normalizedSentiment;
      highlightEl.dataset.eaLocalId = localId;
      highlightEl.dataset.eaDocumentUrl = window.location.href;
      attachHighlightInteractions(highlightEl);
      highlightRegistry.set(localId, {
        element: highlightEl,
        sentiment: normalizedSentiment,
        highlightId: null,
        documentUrl: window.location.href,
        selector: pendingSelection.selector,
        text: pendingSelection.text,
      });
      debugLog("Applied highlight element", {
        sentiment: normalizedSentiment,
        text: highlightEl.textContent?.slice?.(0, 160),
        localId,
      });
    } else {
      debugLog("Highlight element not applied");
    }
    safeSendMessage(
      {
        type: "CONTENT_SELECTION",
        payload: {
          text: pendingSelection.text,
          selector: pendingSelection.selector,
          meta: pendingSelection.meta,
          sentiment: normalizedSentiment,
          context: pendingSelection.context,
          local_id: localId,
          signature: pendingSelection.signature,
        },
      },
      2
    );
    debugLog("Selection message sent", { sentiment: normalizedSentiment });
    lastSentimentChoice = normalizedSentiment;
    pendingSelection = null;
    hideSelectionPopover();
    const htmlSelection = window.getSelection();
    if (htmlSelection) {
      htmlSelection.removeAllRanges();
    }
    debugLog("Pending selection cleared after commit");
    publishPendingSelection();
  }

  function cloneSelector(selector) {
    try {
      return JSON.parse(JSON.stringify(selector));
    } catch (error) {
      debugLog("Selector clone failed, returning original", error);
      return selector;
    }
  }

  function handleSelection() {
    const selection = window.getSelection();
    debugLog("Handle selection invoked", {
      hasSelection: Boolean(selection),
      rangeCount: selection?.rangeCount || 0,
      isCollapsed: selection?.isCollapsed ?? null,
    });
    if (!selection || selection.rangeCount === 0) {
      debugLog("No selection detected");
      clearPendingSelection();
      return;
    }
    if (selection.isCollapsed) {
      debugLog("Selection collapsed – ignoring");
      clearPendingSelection();
      return;
    }

    const range = selection.getRangeAt(0).cloneRange();
    if (!range) {
      debugLog("Unable to clone selection range");
      clearPendingSelection();
      return;
    }

    const ancestorNode = range.commonAncestorContainer;
    const ancestorElement =
      ancestorNode instanceof Element ? ancestorNode : ancestorNode?.parentElement || null;
    if (ancestorElement && ancestorElement.closest(".ea-popover")) {
      debugLog("Selection inside popover – skipping");
      return;
    }
    if (selectionPopover && ancestorElement && selectionPopover.contains(ancestorElement)) {
      debugLog("Selection involves popover element – skipping");
      return;
    }
    if (
      ancestorElement &&
      ancestorElement.closest &&
      ancestorElement.closest("input, textarea, select, [contenteditable]")
    ) {
      debugLog("Selection within editable element – skipping");
      return;
    }

    const rawText = range.toString();
    const selectedText = normalizeWhitespace(rawText);
    if (!selectedText) {
      debugLog("Selection text empty after normalisation");
      clearPendingSelection();
      return;
    }

    const pdfSelector = buildPdfSelector(range, selectedText);
    const selector = pdfSelector || buildTextQuoteSelector(range, selectedText);
    const signatureParts = pdfSelector
      ? [selectedText, pdfSelector.page, pdfSelector.coords?.x1, pdfSelector.coords?.y1]
      : [selectedText, selector.prefix, selector.suffix];
    const signature = JSON.stringify(signatureParts);
    if (!pdfSelector && signature === lastSelectionSignature && pendingSelection) {
      debugLog("Duplicate selection signature – ignoring");
      return;
    }
    lastSelectionSignature = signature;

    const pdfSourceUrl = getPdfSourceUrl();
    const metaUrl = pdfSelector && pdfSourceUrl ? pdfSourceUrl : window.location.href;
    const metaType = pdfSelector ? "pdf" : "html";

    if (pdfSelector) {
      pendingSelection = null;
      hideSelectionPopover();
      debugLog("PDF selection detected – forwarding only", {
        text: selectedText.slice(0, 160),
      });
      safeSendMessage(
        {
          type: "CONTENT_SELECTION",
          payload: {
            text: selectedText,
            selector,
            meta: {
              title: document.title,
              url: metaUrl,
              accessed_at: new Date().toISOString(),
              type: metaType,
              site: (() => {
                try {
                  return new URL(metaUrl).hostname;
                } catch (error) {
                  return window.location.hostname || "";
                }
              })(),
            },
          },
        },
        2
      );
      return;
    }

    ensureStyles();

    const highlightAncestor =
      ancestorElement && ancestorElement.closest
        ? ancestorElement.closest(`.${HIGHLIGHT_CLASS}`)
        : null;
    if (highlightAncestor) {
      debugLog("Selection already highlighted – ignoring");
      return;
    }

    const contextText = extractContextFromRange(range);
    pendingSelection = {
      range,
      text: selectedText,
      selector: cloneSelector(selector),
      context: contextText,
      meta: {
        title: document.title,
        url: window.location.href,
        accessed_at: new Date().toISOString(),
        type: "html",
        site: window.location.hostname || "",
      },
      sentiment: ensureSentimentOption(lastSentimentChoice),
      signature,
    };
    publishPendingSelection();
    debugLog("Pending selection stored", {
      text: selectedText.slice(0, 160),
      contextLength: contextText.length,
      sentiment: pendingSelection.sentiment,
    });
    const rect = range.getBoundingClientRect();
    const clientRects = typeof range.getClientRects === "function" ? range.getClientRects() : null;
    const targetRect =
      rect && rect.width && rect.height
        ? rect
        : clientRects && clientRects.length > 0
          ? clientRects[0]
          : rect;
    positionPopover(targetRect || rect);
    debugLog("Handle selection complete");
  }

  let scholarContextAnnounced = false;

  function maybeAnnounceScholarContext(isScholarHost) {
    if (isScholarHost && !scholarContextAnnounced) {
      chrome.runtime.sendMessage({ type: "SCHOLAR_CONTEXT_DETECTED" });
      scholarContextAnnounced = true;
    } else if (!isScholarHost && scholarContextAnnounced) {
      scholarContextAnnounced = false;
    }
  }

  function checkForSearchQuery() {
    const url = new URL(window.location.href);
    maybeAnnounceScholarContext(/scholar\.google|semanticscholar/i.test(url.hostname));
    for (const platform of SEARCH_PLATFORMS) {
      if (!platform.matcher.test(url.hostname)) {
        continue;
      }
      const query = platform.extract(url);
      if (!query) {
        continue;
      }
      const signature = `${platform.name}:${query}`;
      if (signature === lastSearchSignature) {
        debugLog("Search query unchanged", signature);
        return;
      }
      lastSearchSignature = signature;
      debugLog("Recording search query", { platform: platform.name, query });
      chrome.runtime.sendMessage({
        type: "SEARCH_QUERY",
        payload: {
          platform: platform.name,
          query,
        },
      });
      return;
    }
  }

  document.addEventListener("mousedown", (event) => {
    const target = event.target instanceof Node ? event.target : null;
    const inSelectionPopover = selectionPopover && target && selectionPopover.contains(target);
    const inHighlightMenu = highlightActionPopover && target && highlightActionPopover.contains(target);
    const highlightTarget = target && target.closest ? target.closest(`.${HIGHLIGHT_CLASS}`) : null;
    if (highlightTarget) {
      debugLog("mousedown on existing highlight");
      pointerDown = false;
      hideSelectionPopover();
      highlightActionTarget = highlightTarget;
      positionHighlightActionPopover(highlightTarget);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (inSelectionPopover || inHighlightMenu) {
      pointerDown = false;
      return;
    }
    pointerDown = true;
    hideSelectionPopover();
    hideHighlightActionPopover();
  });

  document.addEventListener("mouseup", () => {
    pointerDown = false;
    debugLog("mouseup detected");
    setTimeout(handleSelection, 50);
    hideHighlightActionPopover();
  });

  document.addEventListener("keyup", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      debugLog("keyup trigger", event.key);
      setTimeout(handleSelection, 50);
    } else if (event.key === "Escape") {
      debugLog("Escape key pressed – clearing selection");
      clearPendingSelection();
      const currentSelection = window.getSelection();
      if (currentSelection) {
        currentSelection.removeAllRanges();
      }
    }
  });

  window.addEventListener(
    "scroll",
    () => {
      if (pendingSelection) {
        debugLog("Scroll detected – hiding popover");
        hideSelectionPopover();
      }
    },
    true
  );

  window.addEventListener("resize", () => {
    if (pendingSelection) {
      debugLog("Resize detected – hiding popover");
      hideSelectionPopover();
    }
  });

  let selectionChangeRaf = null;
  document.addEventListener("selectionchange", () => {
    if (pointerDown) {
      return;
    }
    debugLog("selectionchange event detected");
    if (selectionPopover && document.activeElement instanceof Element) {
      if (selectionPopover.contains(document.activeElement)) {
        debugLog("selectionchange ignored – focus within popover");
        return;
      }
    }
    if (selectionChangeRaf) {
      cancelAnimationFrame(selectionChangeRaf);
    }
    selectionChangeRaf = requestAnimationFrame(() => {
      selectionChangeRaf = null;
      debugLog("selectionchange RAF firing");
      handleSelection();
    });
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      debugLog("Document hidden – clearing pending selection");
      clearPendingSelection();
    }
  });

  ensureStyles();
  debugLog("Content script initialised", { debug: DEBUG_ENABLED });
  checkForSearchQuery();
  setInterval(checkForSearchQuery, 2000);
  window.addEventListener("popstate", checkForSearchQuery);

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || !message.type) {
      return;
    }
    if (message.type === "HTML_HIGHLIGHT_SAVED") {
      const { local_id: localId, highlight_id: highlightId, document_url: documentUrl } = message.payload || {};
      if (!localId || !highlightRegistry.has(localId)) {
        return;
      }
      const entry = highlightRegistry.get(localId);
      if (entry?.element) {
        entry.element.dataset.eaHighlightId = highlightId || "";
        if (documentUrl) {
          entry.element.dataset.eaDocumentUrl = documentUrl;
        }
      }
      highlightRegistry.set(localId, {
        ...entry,
        highlightId: highlightId || null,
        documentUrl: documentUrl || entry?.documentUrl || window.location.href,
      });
      debugLog("Highlight saved", { localId, highlightId });
    } else if (message.type === "HTML_HIGHLIGHT_SAVE_FAILED") {
      const { local_id: localId } = message.payload || {};
      const entry = localId ? highlightRegistry.get(localId) : null;
      if (entry?.element) {
        unwrapHighlightElement(entry.element);
      }
      if (localId) {
        highlightRegistry.delete(localId);
      }
      debugLog("Highlight save failed", { localId });
    } else if (message.type === "HTML_HIGHLIGHT_REMOVED") {
      const { local_id: localId, highlight_id: highlightId } = message.payload || {};
      let resolvedLocalId = localId || null;
      let entry = null;
      if (resolvedLocalId && highlightRegistry.has(resolvedLocalId)) {
        entry = highlightRegistry.get(resolvedLocalId);
      } else if (highlightId) {
        for (const [key, value] of highlightRegistry.entries()) {
          if (value.highlightId && value.highlightId === highlightId) {
            resolvedLocalId = key;
            entry = value;
            break;
          }
        }
      }
      if (entry?.element) {
        unwrapHighlightElement(entry.element);
      }
      unwrapHighlightsByIdentifiers({ localId: resolvedLocalId, highlightId });
      if (resolvedLocalId) {
        highlightRegistry.delete(resolvedLocalId);
      }
      hideHighlightActionPopover();
      debugLog("Highlight removal confirmed", { localId: resolvedLocalId, highlightId });
    } else if (message.type === "HTML_HIGHLIGHT_REMOVE_FAILED") {
      debugLog("Highlight removal failed", message.payload || {});
    }
  });

  document.addEventListener(
    "click",
    (event) => {
      if (event.defaultPrevented || event.button !== 0) {
        return;
      }
      const anchor = event.target.closest("a[href]");
      if (!anchor || !anchor.href) {
        return;
      }
      safeSendMessage(
        {
          type: "SEARCH_INTERACTION",
          payload: {
            type: "open_result",
            url: anchor.href,
            title: anchor.textContent?.trim() || anchor.href,
            context: {
              page_url: window.location.href,
              page_title: document.title,
            },
          },
        },
        1
      );
    },
    true
  );
})();
