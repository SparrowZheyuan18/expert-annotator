/* global chrome */

const MAX_CONTEXT_CHARS = 30;
let lastSelectionSignature = null;

function normalizeWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}

function extractContext(range, direction) {
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
    return "";
  }
}

function buildSelector(range, text) {
  return {
    type: "TextQuote",
    exact: text,
    prefix: extractContext(range, "prefix"),
    suffix: extractContext(range, "suffix"),
  };
}

function handleSelection() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return;
  }

  const selectedText = normalizeWhitespace(selection.toString());
  if (!selectedText) {
    return;
  }

  const range = selection.getRangeAt(0).cloneRange();
  const selector = buildSelector(range, selectedText);
  const signature = JSON.stringify([selectedText, selector.prefix, selector.suffix]);
  if (signature === lastSelectionSignature) {
    return;
  }
  lastSelectionSignature = signature;

  chrome.runtime.sendMessage({
    type: "CONTENT_SELECTION",
    payload: {
      text: selectedText,
      selector,
      meta: {
        title: document.title,
        url: window.location.href,
        accessed_at: new Date().toISOString(),
      },
    },
  });
}

document.addEventListener("mousedown", () => {
  lastSelectionSignature = null;
});

document.addEventListener("mouseup", () => {
  setTimeout(handleSelection, 50);
});

document.addEventListener("keyup", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    setTimeout(handleSelection, 50);
  }
});
