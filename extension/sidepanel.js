const { api, storage } = window.EXPERT_ANNOTATOR;
const openJson = window.EXPERT_ANNOTATOR.openJsonInNewTab;

const noticeEl = document.getElementById("notice");
const sessionInfoEl = document.getElementById("session-info");
const highlightContainer = document.getElementById("highlight-container");
const exportButton = document.getElementById("export-btn");
const pdfButton = document.getElementById("open-pdf-btn");
const finishButton = document.getElementById("finish-btn");
const template = document.getElementById("highlight-template");
const highlightSummary = window.__EA_HIGHLIGHT_SUMMARY__;

const HTML_SENTIMENT_OPTIONS = [
  { value: "thumbsup", label: "Thumbs up" },
  { value: "thumbsdown", label: "Thumbs down" },
];

const SENTIMENT_CANONICALS = new Set([
  ...HTML_SENTIMENT_OPTIONS.map((option) => option.value),
  "neutral_information",
]);
const SENTIMENT_ALIAS_MAP = {
  "thumbs up": "thumbsup",
  "👍": "thumbsup",
  "thumbs-down": "thumbsdown",
  "thumbs down": "thumbsdown",
  "👎": "thumbsdown",
  "neutral information": "neutral_information",
  "neutral-information": "neutral_information",
};
const LEGACY_PDF_SENTIMENT_MAP = {
  "pdf highlight": "neutral_information",
  "core concept": "thumbsup",
  "not relevant": "thumbsdown",
  "method weakness": "thumbsdown",
  "generate new search": "neutral_information",
  "search result": "neutral_information",
};
const DEFAULT_PDF_SENTIMENT = "thumbsup";
const AI_SUGGESTION_PLACEHOLDER =
  "Explain why this snippet matters (edit an AI-suggested rationale!)";
const AI_SUGGESTION_LOADING_COUNT = 3;

function truncateTextForSuggestions(text = "", maxLength = 160) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}…` : trimmed;
}

function normalizeAiSuggestionEntry(entry, index = 0) {
  if (!entry) {
    return null;
  }
  if (typeof entry === "object") {
    const titleCandidate = String(
      entry.title || entry.heading || entry.label || entry.topic || ""
    ).trim();
    const detailCandidate = String(
      entry.detail || entry.text || entry.body || entry.description || entry.content || ""
    ).trim();
    if (!detailCandidate) {
      return null;
    }
    return {
      title: titleCandidate || `Idea ${index + 1}`,
      detail: detailCandidate,
    };
  }
  if (typeof entry === "string") {
    const trimmed = entry.trim();
    if (!trimmed) {
      return null;
    }
    const separators = ["::", "—", " - ", ":", "-"];
    for (const separator of separators) {
      const sepIndex = trimmed.indexOf(separator);
      if (sepIndex > 0) {
        const proposedTitle = trimmed.slice(0, sepIndex).trim();
        const proposedDetail = trimmed.slice(sepIndex + separator.length).trim();
        if (proposedDetail) {
          return {
            title: proposedTitle || `Idea ${index + 1}`,
            detail: proposedDetail,
          };
        }
      }
    }
    return {
      title: `Idea ${index + 1}`,
      detail: trimmed,
    };
  }
  return null;
}

function normalizeAiSuggestions(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }
  const normalized = [];
  entries.forEach((entry, index) => {
    const suggestion = normalizeAiSuggestionEntry(entry, index);
    if (suggestion) {
      normalized.push(suggestion);
    }
  });
  return normalized;
}

function buildFallbackAiSuggestions(selectionText = "") {
  const snippet = truncateTextForSuggestions(selectionText);
  return [
    {
      title: "Explain impact",
      detail: snippet ? `Explain why this snippet matters: "${snippet}"` : "Explain why this snippet matters.",
    },
    {
      title: "Question gaps",
      detail: "Identify assumptions, evidence gaps, or risks you should revisit.",
    },
    {
      title: "Plan action",
      detail: "Capture what you should do next based on this passage.",
    },
  ];
}

function buildAiSuggestionSkeletons(count = AI_SUGGESTION_LOADING_COUNT) {
  return Array.from({ length: count }).map((_, index) => ({
    title: `Idea ${index + 1}`,
    detail: "",
  }));
}

function getDisplaySuggestions(rawSuggestions, selectionText = "") {
  const normalized = normalizeAiSuggestions(rawSuggestions);
  if (normalized.length > 0) {
    return normalized;
  }
  return buildFallbackAiSuggestions(selectionText);
}

function normaliseSentimentValue(rawValue) {
  if (rawValue === null || rawValue === undefined) {
    return null;
  }
  const key = String(rawValue).trim().toLowerCase();
  if (!key) {
    return null;
  }
  if (SENTIMENT_CANONICALS.has(key)) {
    return key;
  }
  if (SENTIMENT_ALIAS_MAP[key]) {
    return SENTIMENT_ALIAS_MAP[key];
  }
  if (LEGACY_PDF_SENTIMENT_MAP[key]) {
    return LEGACY_PDF_SENTIMENT_MAP[key];
  }
  return null;
}

function ensurePdfSentiment(rawValue) {
  return normaliseSentimentValue(rawValue) || DEFAULT_PDF_SENTIMENT;
}

function normalisePdfUserJudgment(judgment = {}) {
  const canonical = ensurePdfSentiment(judgment.chosen_label);
  if (judgment.chosen_label === canonical) {
    return judgment;
  }
  return {
    ...judgment,
    chosen_label: canonical,
  };
}

function normalisePdfHighlightEntry(entry) {
  if (!entry) {
    return { highlight: entry, changed: false };
  }
  const normalized = { ...entry };
  let changed = false;
  const currentJudgment = entry.user_judgment || entry.userJudgment || {};
  const updatedJudgment = normalisePdfUserJudgment(currentJudgment);
  if (updatedJudgment !== currentJudgment) {
    normalized.user_judgment = updatedJudgment;
    changed = true;
  } else if (!normalized.user_judgment) {
    normalized.user_judgment = updatedJudgment;
    changed = true;
  }
  const canonical = normalized.user_judgment.chosen_label;
  if (canonical && normalized.sentiment !== canonical) {
    normalized.sentiment = canonical;
    changed = true;
  }
  if (normalized.chosen_label && normalized.chosen_label !== canonical) {
    delete normalized.chosen_label;
    changed = true;
  }
  return { highlight: normalized, changed };
}

function normalisePdfDocumentEntry(docEntry) {
  if (!docEntry || docEntry.type !== "pdf") {
    return false;
  }
  let mutated = false;
  if (Array.isArray(docEntry.highlights)) {
    const nextHighlights = docEntry.highlights.map((highlight) => {
      const { highlight: normalized, changed } = normalisePdfHighlightEntry(highlight);
      if (changed) {
        mutated = true;
      }
      return normalized;
    });
    docEntry.highlights = nextHighlights;
  }
  if (docEntry.pdf_review && typeof docEntry.pdf_review === "object") {
    const canonical = ensurePdfSentiment(docEntry.pdf_review.sentiment);
    if (docEntry.pdf_review.sentiment !== canonical) {
      docEntry.pdf_review = {
        ...docEntry.pdf_review,
        sentiment: canonical,
      };
      mutated = true;
    }
  }
  return mutated;
}

function sentimentToOverlayColor(sentiment) {
  const canonical = ensurePdfSentiment(sentiment);
  if (canonical === "thumbsup") {
    return "positive";
  }
  if (canonical === "thumbsdown") {
    return "negative";
  }
  return "neutral";
}

function extractSiteFromUrl(url) {
  if (!url) {
    return "";
  }
  try {
    return new URL(url).hostname;
  } catch (error) {
    return "";
  }
}

if (highlightSummary) {
  highlightSummary.setEditHandler((entry) => {
    if (!entry) {
      return;
    }
    openHighlightEditor(entry);
  });
  highlightSummary.setDeleteHandler((entry) => {
    deleteHighlightFromSummary(entry);
  });
}

let currentSession = null;
let documentsIndex = {};
let currentTabInfo = { url: "", title: "" };
let currentPdfCandidate = null;
let activeHighlightRef = null;

function derivePdfCandidate(rawUrl) {
  if (!rawUrl) {
    return null;
  }
  try {
    const url = new URL(rawUrl);
    const normalizedPath = url.pathname.toLowerCase();

    if (normalizedPath.endsWith(".pdf") || normalizedPath.includes(".pdf/") || normalizedPath.includes(".pdf?")) {
      url.hash = "";
      return url.toString();
    }

    if (url.hostname.endsWith("arxiv.org") && normalizedPath.startsWith("/pdf/")) {
      if (!normalizedPath.endsWith(".pdf")) {
        url.pathname = `${url.pathname}.pdf`;
      }
      url.hash = "";
      return url.toString();
    }

    const contentType = url.searchParams.get("content-type");
    if (contentType && contentType.toLowerCase().includes("pdf")) {
      url.hash = "";
      return url.toString();
    }

    return null;
  } catch (error) {
    return null;
  }
}

function setNotice(message, tone = "info") {
  noticeEl.textContent = message;
  noticeEl.classList.toggle("error", tone === "error");
  noticeEl.hidden = !message;
}

function renderDocumentSummaryInfo(documentMeta) {
  const summarySection = document.getElementById("document-summary");
  if (summarySection) {
    summarySection.hidden = true;
    summarySection.innerHTML = "";
  }
  if (!documentMeta) {
    return;
  }
  const sessionId = currentSession?.session_id;
  if (sessionId) {
    const sessionDocs = documentsIndex[sessionId] || {};
    const entry = sessionDocs[documentMeta.url];
    if (entry) {
      const nextSummary = documentMeta.global_judgment || null;
      const currentSummary = entry.global_judgment || null;
      if (JSON.stringify(currentSummary) !== JSON.stringify(nextSummary)) {
        entry.global_judgment = nextSummary;
        sessionDocs[documentMeta.url] = entry;
        documentsIndex[sessionId] = sessionDocs;
        storage.set({
          [storage.keys.DOCUMENTS]: documentsIndex,
        });
      }
    }
  }
  if (highlightSummary && documentMeta.document_id) {
    highlightSummary.updateDocumentSummary(documentMeta.document_id, documentMeta.global_judgment || null);
  }
}

function formatDate(isoString) {
  try {
    return new Date(isoString).toLocaleString();
  } catch (error) {
    return isoString;
  }
}

async function loadState() {
  const stored = await storage.get([storage.keys.SESSION, storage.keys.DOCUMENTS]);
  currentSession = stored[storage.keys.SESSION] || null;
  documentsIndex = stored[storage.keys.DOCUMENTS] || {};
  let normalizationApplied = false;
  Object.values(documentsIndex).forEach((sessionDocs) => {
    Object.values(sessionDocs || {}).forEach((doc) => {
      if (normalisePdfDocumentEntry(doc)) {
        normalizationApplied = true;
      }
    });
  });
  if (normalizationApplied) {
    await storage.set({
      [storage.keys.DOCUMENTS]: documentsIndex,
    });
  }
  if (highlightSummary) {
    const sessionDocs = currentSession ? documentsIndex[currentSession.session_id] || {} : {};
    const entries = [];
    Object.values(sessionDocs).forEach((doc) => {
      const review = doc.pdf_review || null;
      const highlightOrder = Array.isArray(review?.highlight_order) ? review.highlight_order : [];
      if (Array.isArray(doc.highlights)) {
        doc.highlights.forEach((h, idx) => {
          const rect = Array.isArray(h.selector?.rects) ? h.selector.rects[0] : null;
          const fingerprint = rect
            ? [rect.x1, rect.y1, rect.x2, rect.y2].map((v) => Number(v).toFixed(2)).join(":")
            : null;
          const highlightId = h.highlight_id || null;
          const rankIndex = highlightId ? highlightOrder.indexOf(highlightId) : -1;
          entries.push({
            id: h.highlight_id || h.local_id || `${doc.document_id}-hl-${idx}` ,
            highlightId,
            localId: h.local_id || null,
            documentId: doc.document_id,
            documentTitle: doc.title || doc.url,
            documentUrl: doc.url,
            documentType: doc.type,
            documentSentiment: review?.sentiment || null,
            documentReview: review,
            documentSummary: doc.global_judgment || null,
            url: doc.url,
            title: doc.title || doc.url,
            type: doc.type,
            page: h.selector?.page || null,
            text: h.text || "",
            saved: true,
            fingerprint,
            selector: h.selector,
            user_judgment: h.user_judgment,
            ai_suggestions: h.ai_suggestions || [],
            context: h.context || null,
            rank: rankIndex >= 0 ? rankIndex + 1 : null,
          });
        });
      }
    });
    highlightSummary.reset(entries);
  }

  if (currentSession) {
    sessionInfoEl.textContent = `${currentSession.expert_name} · ${currentSession.topic}`;
    exportButton.disabled = false;
    finishButton.disabled = false;
    setNotice("Select text in the active tab to generate highlights.");
  } else {
    sessionInfoEl.textContent = "No active session";
    exportButton.disabled = true;
    finishButton.disabled = true;
    setNotice("Start a session from the popup before highlighting.", "error");
    clearHighlights();
  }
  updatePdfButtonState();
}

async function ensureDocument(meta) {
  if (!currentSession) {
    throw new Error("No active session");
  }
  const sessionId = currentSession.session_id;
  const sessionDocs = documentsIndex[sessionId] || {};

  if (sessionDocs[meta.url]) {
    const existing = sessionDocs[meta.url];
    if (!existing.type && meta.type) {
      existing.type = meta.type;
    }
    if (!existing.global_judgment && meta.global_judgment) {
      existing.global_judgment = meta.global_judgment;
    }
    if (!existing.pdf_review && meta.pdf_review) {
      existing.pdf_review = meta.pdf_review;
    }
    if (normalisePdfDocumentEntry(existing)) {
      sessionDocs[meta.url] = existing;
    }
    documentsIndex[sessionId] = sessionDocs;
    await storage.set({
      [storage.keys.DOCUMENTS]: documentsIndex,
    });
    return existing.document_id;
  }

  const document = await api.request(`/sessions/${sessionId}/documents`, {
    method: "POST",
    body: JSON.stringify({
      title: meta.title || meta.url,
      url: meta.url,
      type: meta.type || "html",
      accessed_at: meta.accessed_at,
    }),
  });

  documentsIndex[sessionId] = {
    ...sessionDocs,
    [meta.url]: {
      document_id: document.document_id,
      title: document.title,
      accessed_at: document.accessed_at,
      type: document.type,
      global_judgment: document.global_judgment || null,
      pdf_review: document.pdf_review || null,
    },
  };
  if (documentsIndex[sessionId][meta.url] && normalisePdfDocumentEntry(documentsIndex[sessionId][meta.url])) {
    documentsIndex[sessionId][meta.url] = documentsIndex[sessionId][meta.url];
  }

  await storage.set({
    [storage.keys.DOCUMENTS]: documentsIndex,
  });

  return document.document_id;
}

function clearHighlights() {
  highlightContainer.innerHTML = "";
  activeHighlightRef = null;
}

function setActiveHighlightRef(selection) {
  activeHighlightRef = {
    highlightId: selection.highlightId || selection.id || null,
    localId: selection.localId || null,
  };
}

function maybeClearActiveHighlight({ highlightId = null, localId = null } = {}) {
  if (!activeHighlightRef) {
    return false;
  }
  const matchById =
    highlightId
    && activeHighlightRef.highlightId
    && activeHighlightRef.highlightId === highlightId;
  const matchByLocal =
    !highlightId
    && localId
    && activeHighlightRef.localId
    && activeHighlightRef.localId === localId;
  if (matchById || matchByLocal) {
    clearHighlights();
    return true;
  }
  return false;
}

function createAiSuggestionPicker(suggestions, onSelect, options = {}) {
  const { isLoading = false } = options;
  const wrapper = document.createElement("div");
  wrapper.className = "ai-suggestion-picker";
  if (isLoading) {
    wrapper.classList.add("ai-suggestion-picker--loading");
  }
  const list = document.createElement("ul");
  list.className = "ai-suggestion-list";
  suggestions.forEach((suggestion) => {
    const item = document.createElement("li");
    if (isLoading) {
      item.className = "ai-suggestion-skeleton";
      const titleSkeleton = document.createElement("span");
      titleSkeleton.className = "skeleton-line skeleton-line--short";
      const detailSkeleton = document.createElement("span");
      detailSkeleton.className = "skeleton-line skeleton-line--long";
      item.appendChild(titleSkeleton);
      item.appendChild(detailSkeleton);
      list.appendChild(item);
      return;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ai-suggestion-option";
    const title = document.createElement("strong");
    title.textContent = suggestion.title;
    const detail = document.createElement("span");
    detail.textContent = suggestion.detail;
    button.appendChild(title);
    button.appendChild(detail);
    button.addEventListener("click", () => {
      if (typeof onSelect === "function") {
        onSelect(suggestion);
      }
    });
    item.appendChild(button);
    list.appendChild(item);
  });
  wrapper.appendChild(list);
  return wrapper;
}

function renderAiSuggestionsContent(container, suggestions, options = {}) {
  if (!container) {
    return;
  }
  const { onSelect, isLoading = false } = options;
  const heading = document.createElement("h3");
  heading.textContent = "AI suggestions";
  if (isLoading) {
    const status = document.createElement("span");
    status.className = "ai-suggestion-status";
    const spinner = document.createElement("span");
    spinner.className = "ai-suggestion-spinner";
    status.appendChild(spinner);
    status.append("Generating…");
    heading.appendChild(status);
  }
  const helper = document.createElement("p");
  helper.className = "ai-suggestion-helper";
  helper.textContent = AI_SUGGESTION_PLACEHOLDER;
  const picker = createAiSuggestionPicker(suggestions, onSelect, { isLoading });
  container.replaceChildren(heading, helper, picker);
}

function renderHighlightCard(selection, documentMeta) {
  clearHighlights();

  const fragment = template.content.cloneNode(true);
  const card = fragment.querySelector(".highlight-card");
  const titleEl = fragment.querySelector(".doc-title");
  const urlEl = fragment.querySelector(".doc-url");
  const capturedAtEl = fragment.querySelector(".captured-at");
  const selectedTextEl = fragment.querySelector(".selected-text");
  const suggestionsSection = fragment.querySelector(".suggestions");
  const linksContainer = document.createElement("div");
  linksContainer.className = "reference-links";
  const selectEl = fragment.querySelector(".label-select");
  const reasoningEl = fragment.querySelector(".reasoning-input");
  const confidenceEl = fragment.querySelector(".confidence-input");
  const removeBtn = fragment.querySelector(".remove-btn");
  const saveBtn = fragment.querySelector(".save-btn");
  const saveStatusEl = fragment.querySelector(".save-status");
  const labelField = selectEl.closest(".field");
  const reasoningField = reasoningEl.closest(".field");
  const confidenceField = confidenceEl.closest(".field");

  const isPdf = documentMeta.type === "pdf";
  const initialJudgment = selection.user_judgment || {};
  const existingJudgment = isPdf ? normalisePdfUserJudgment(initialJudgment) : initialJudgment;
  if (isPdf) {
    selection.user_judgment = existingJudgment;
    const canonicalSentiment = ensurePdfSentiment(selection.sentiment || existingJudgment.chosen_label);
    selection.sentiment = canonicalSentiment;
    if (existingJudgment.chosen_label !== canonicalSentiment) {
      selection.user_judgment = {
        ...existingJudgment,
        chosen_label: canonicalSentiment,
      };
    }
  }
  const awaitingSuggestions = Boolean(selection.isAwaitingSuggestions);
  const aiOptions = awaitingSuggestions
    ? (Array.isArray(selection.suggestions) && selection.suggestions.length
      ? selection.suggestions
      : buildAiSuggestionSkeletons())
    : getDisplaySuggestions(selection.suggestions, selection.text);
  selection.suggestions = aiOptions;
  const highlightId = selection.highlightId || selection.id || null;
  const fingerprint = selection.fingerprint || null;
  setActiveHighlightRef(selection);
  renderDocumentSummaryInfo(documentMeta);

  const populateSelect = (selectNode, options, preferredValue, fallbackValue) => {
    selectNode.innerHTML = "";
    options.forEach((option) => {
      const opt = document.createElement("option");
      opt.value = option.value;
      opt.textContent = option.label;
      selectNode.appendChild(opt);
    });
    const hasPreferred = preferredValue && options.some((option) => option.value === preferredValue);
    if (hasPreferred) {
      selectNode.value = preferredValue;
    } else if (fallbackValue && options.some((option) => option.value === fallbackValue)) {
      selectNode.value = fallbackValue;
    } else if (options.length > 0) {
      selectNode.value = options[0].value;
    }
  };

  const selectedSentiment = selection.sentiment || existingJudgment.chosen_label || null;
  if (selectEl) {
    const optionSet = HTML_SENTIMENT_OPTIONS;
    const fallbackValue = optionSet[0]?.value;
    populateSelect(selectEl, optionSet, selectedSentiment, fallbackValue);
  }

  if (removeBtn) {
    removeBtn.addEventListener("click", async () => {
      if (removeBtn.disabled) {
        return;
      }
      const originalLabel = removeBtn.textContent;
      removeBtn.disabled = true;
      removeBtn.textContent = "Removing…";
      try {
        await handleHtmlHighlightRemovalRequest(
          {
            highlight_id: selection.highlightId || selection.id || null,
            local_id: selection.localId || null,
            document_url: documentMeta.url || currentTabInfo.url || "",
          },
        );
      } catch (error) {
        console.debug("Inline highlight removal failed", error);
        setNotice(error.message || "Failed to remove highlight.", "error");
      } finally {
        if (removeBtn.isConnected) {
          removeBtn.disabled = false;
          removeBtn.textContent = originalLabel;
        }
      }
    });
  }

  if (existingJudgment.confidence !== undefined && existingJudgment.confidence !== null && confidenceEl) {
    confidenceEl.value = `${existingJudgment.confidence}`;
  } else if (confidenceEl) {
    confidenceEl.value = "";
  }

  titleEl.textContent = documentMeta.title || "Untitled document";
  urlEl.textContent = documentMeta.url;
  urlEl.href = documentMeta.url;
  const docTypeLabel = documentMeta.type ? documentMeta.type.toUpperCase() : "HTML";
  const pageLabel = selection.selector.type === "PDFText" ? ` · Page ${selection.selector.page}` : "";
  capturedAtEl.textContent = `Accessed: ${formatDate(documentMeta.accessed_at)} · ${docTypeLabel}${pageLabel}`;
  selectedTextEl.textContent = selection.text;
  const sentimentForCard = selection.sentiment || existingJudgment.chosen_label || null;
  if (sentimentForCard) {
    selectedTextEl.dataset.sentiment = sentimentForCard;
  } else {
    delete selectedTextEl.dataset.sentiment;
  }

  const contextInsertTarget = card.querySelector(".suggestions");
  const contextValue = (() => {
    if (isPdf) {
      return documentMeta.title || documentMeta.url || "";
    }
    if (typeof selection.context === "string" && selection.context.trim()) {
      return selection.context.trim();
    }
    return "";
  })();
  if (contextValue && contextInsertTarget) {
    const contextBlock = document.createElement("div");
    contextBlock.className = "highlight-context";
    if (isPdf) {
      contextBlock.classList.add("highlight-context--pdf");
    }
    contextBlock.textContent = contextValue;
    card.insertBefore(contextBlock, contextInsertTarget);
    selection.context = contextValue;
  } else if (!selection.context) {
    selection.context = null;
  }

  const applyAiSuggestion = (selectedSuggestion) => {
    if (!selectedSuggestion || !selectedSuggestion.detail) {
      return;
    }
    reasoningEl.value = selectedSuggestion.detail;
  };
  card.__applySuggestion = applyAiSuggestion;
  card.dataset.docType = documentMeta.type || "html";
  renderAiSuggestionsContent(suggestionsSection, aiOptions, {
    onSelect: applyAiSuggestion,
    isLoading: Boolean(selection.isAwaitingSuggestions),
  });
  if (saveBtn && !saveBtn.dataset.defaultLabel) {
    saveBtn.dataset.defaultLabel = saveBtn.textContent || "Save highlight";
  }
  const setAiLoadingState = (isLoading) => {
    if (!saveBtn) {
      return;
    }
    if (isLoading) {
      saveBtn.disabled = true;
      saveBtn.textContent = "Waiting for AI…";
      card.classList.add("ai-suggestions-loading");
    } else {
      saveBtn.disabled = false;
      saveBtn.textContent = saveBtn.dataset.defaultLabel || "Save highlight";
      card.classList.remove("ai-suggestions-loading");
    }
  };
  card.__setAiLoadingState = setAiLoadingState;
  setAiLoadingState(Boolean(selection.isAwaitingSuggestions));

  if (Array.isArray(selection.links) && selection.links.length > 0) {
    const heading = document.createElement("h3");
    heading.textContent = "Links";
    linksContainer.appendChild(heading);
    const list = document.createElement("ul");
    selection.links.forEach((link) => {
      const item = document.createElement("li");
      const anchor = document.createElement("a");
      anchor.href = link.href;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.textContent = link.text || link.href;
      item.appendChild(anchor);
      list.appendChild(item);
    });
    linksContainer.appendChild(list);
    card.insertBefore(linksContainer, card.querySelector(".field"));
  }

  if (isPdf) {
    const labelTitle = labelField.querySelector(".field-label");
    if (labelTitle) {
      labelTitle.textContent = "Sentiment";
    }
    const reasoningLabel = reasoningField.querySelector(".field-label");
    if (reasoningLabel) {
      reasoningLabel.textContent = "Comments";
    }
    reasoningEl.placeholder = "Capture how this passage shapes your understanding.";
    if (confidenceField) {
      confidenceField.style.display = "none";
    }
    const firstSuggestionDetail = selection.suggestions?.[0]?.detail || "";
    reasoningEl.value = existingJudgment.reasoning || firstSuggestionDetail;
  } else {
    if (labelField) {
      labelField.style.display = "";
      const labelTitle = labelField.querySelector(".field-label");
      if (labelTitle) {
        labelTitle.textContent = "Sentiment";
      }
    }
    if (confidenceField) {
      confidenceField.style.display = "none";
    }
    const reasoningLabel = reasoningField.querySelector(".field-label");
    if (reasoningLabel) {
      reasoningLabel.textContent = "Reasoning";
    }
    reasoningEl.placeholder = "Explain why this snippet is notable.";
    reasoningEl.value = existingJudgment.reasoning || "";
  }

  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    saveStatusEl.textContent = "Saving…";
    saveStatusEl.classList.remove("success", "error");

    const confidenceValue = confidenceEl.value?.trim?.() || "";
    const confidence = confidenceValue ? Number(confidenceValue) : null;

    let userJudgment;
    if (isPdf) {
      userJudgment = normalisePdfUserJudgment({
        chosen_label: selectEl.value,
        reasoning: reasoningEl.value.trim(),
      });
      selection.user_judgment = userJudgment;
      selection.sentiment = userJudgment.chosen_label;
    } else {
      userJudgment = {
        chosen_label: selectEl.value,
        reasoning: reasoningEl.value.trim(),
      };
    }

    const payload = {
      text: selection.text,
      selector: selection.selector,
      ai_suggestions: selection.suggestions,
      user_judgment: userJudgment,
      context: selection.context || null,
    };

    try {
      let response;
      if (highlightId) {
        response = await api.request(`/highlights/${highlightId}`, {
          method: "PATCH",
          body: JSON.stringify({ user_judgment: userJudgment }),
        });
        removeHighlightFromSummary(documentMeta.url, selection.selector?.page || null, fingerprint);
      } else {
        response = await api.request(
          `/sessions/${currentSession.session_id}/documents/${documentMeta.document_id}/highlights`,
          {
            method: "POST",
            body: JSON.stringify(payload),
          }
        );
      }
      saveStatusEl.textContent = `Saved (ID: ${response.highlight_id})`;
      saveStatusEl.classList.add("success");
      selection.highlightId = response.highlight_id;
      setActiveHighlightRef(selection);

      if (documentMeta.type === "pdf" && payload.selector?.rects?.length) {
        try {
          const overlayColor = sentimentToOverlayColor(userJudgment.chosen_label);
          const rectPayloads = payload.selector.rects.map((rect) => ({
            ...rect,
            highlightId: response.highlight_id,
            localId: selection.localId || null,
            color: overlayColor,
          }));
          chrome.runtime.sendMessage({
            type: "PDF_HIGHLIGHT_CREATED",
            payload: {
              url: documentMeta.url,
              page: payload.selector.page,
              rects: rectPayloads,
              highlight_id: response.highlight_id,
              local_id: selection.localId || null,
            },
          });
        } catch (error) {
          console.debug("PDF overlay update failed", error);
        }
      }

      addHighlightToSummary(documentMeta, {
        ...selection,
        text: selection.text,
        selector: selection.selector,
        saved: true,
        id: response.highlight_id,
        highlightId: response.highlight_id,
        user_judgment: userJudgment,
        ai_suggestions: payload.ai_suggestions,
        fingerprint,
        context: selection.context || null,
      });

      const sessionDocs = documentsIndex[currentSession.session_id] || {};
      const docEntry = sessionDocs[documentMeta.url];
      if (docEntry) {
        docEntry.highlights = docEntry.highlights || [];
        docEntry.highlights = docEntry.highlights.filter((h) => h.highlight_id !== highlightId);
        docEntry.highlights.push({
          highlight_id: response.highlight_id,
          text: selection.text,
          context: selection.context || null,
          selector: selection.selector,
          user_judgment: userJudgment,
          ai_suggestions: payload.ai_suggestions,
        });
        if (documentMeta.global_judgment) {
          docEntry.global_judgment = documentMeta.global_judgment;
        }
        if (documentMeta.type === "pdf") {
          normalisePdfDocumentEntry(docEntry);
        }
        sessionDocs[documentMeta.url] = docEntry;
        documentsIndex[currentSession.session_id] = sessionDocs;
        await storage.set({
          [storage.keys.DOCUMENTS]: documentsIndex,
        });
      }

      if (!isPdf && !highlightId && selection.localId) {
        chrome.runtime.sendMessage({
          type: "HTML_HIGHLIGHT_SAVED",
          payload: {
            local_id: selection.localId || null,
            highlight_id: response.highlight_id,
            document_url: documentMeta.url,
          },
        });
      }
    } catch (error) {
      console.error("Failed to save highlight", error);
      saveStatusEl.textContent = error.message || "Failed to save highlight.";
      saveStatusEl.classList.add("error");
      if (!isPdf && !highlightId && selection.localId) {
        chrome.runtime.sendMessage({
          type: "HTML_HIGHLIGHT_SAVE_FAILED",
          payload: {
            local_id: selection.localId || null,
            reason: error.message || String(error),
          },
        });
      }
    } finally {
      saveBtn.disabled = false;
    }
  });

  highlightContainer.appendChild(fragment);
}

async function autoSaveHtmlHighlight(selection, documentMeta, documentId) {
  clearHighlights();
  const sentiment = selection.sentiment || HTML_SENTIMENT_OPTIONS[0]?.value || "thumbsup";
  const userJudgment = {
    chosen_label: sentiment,
    reasoning: "",
  };
  const aiSuggestions = getDisplaySuggestions(selection.suggestions, selection.text);
  selection.suggestions = aiSuggestions;

  const payload = {
    text: selection.text,
    selector: selection.selector,
    ai_suggestions: aiSuggestions,
    user_judgment: userJudgment,
    context: selection.context || null,
  };

  try {
    const response = await api.request(
      `/sessions/${currentSession.session_id}/documents/${documentId}/highlights`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      }
    );

    addHighlightToSummary(documentMeta, {
      ...selection,
      saved: true,
      id: response.highlight_id,
      highlightId: response.highlight_id,
      user_judgment: userJudgment,
    });

    const sessionDocs = documentsIndex[currentSession.session_id] || {};
    const docEntry = sessionDocs[documentMeta.url];
    if (docEntry) {
      docEntry.highlights = docEntry.highlights || [];
      docEntry.highlights.push({
        highlight_id: response.highlight_id,
        text: selection.text,
        context: selection.context || null,
        selector: selection.selector,
        user_judgment: userJudgment,
        ai_suggestions: payload.ai_suggestions,
      });
      sessionDocs[documentMeta.url] = docEntry;
      documentsIndex[currentSession.session_id] = sessionDocs;
      await storage.set({
        [storage.keys.DOCUMENTS]: documentsIndex,
      });
    }

    chrome.runtime.sendMessage({
      type: "HTML_HIGHLIGHT_SAVED",
      payload: {
        local_id: selection.localId || null,
        highlight_id: response.highlight_id,
        document_url: documentMeta.url,
      },
    });
  } catch (error) {
    chrome.runtime.sendMessage({
      type: "HTML_HIGHLIGHT_SAVE_FAILED",
      payload: {
        local_id: selection.localId || null,
        reason: error.message || String(error),
      },
    });
    throw error;
  }
}

async function savePdfDocumentReview(review) {
  if (!currentSession) {
    throw new Error("No active session");
  }
  const sessionDocs = documentsIndex[currentSession.session_id] || {};
  const docKey = Object.keys(sessionDocs).find((key) => sessionDocs[key].document_id === review.documentId);
  if (!docKey) {
    throw new Error("Document not found in session cache");
  }
  const uniqueOrder = Array.isArray(review.highlightOrder) ? Array.from(new Set(review.highlightOrder)) : [];
  const payload = {
    sentiment: review.sentiment,
    highlight_order: uniqueOrder,
  };
  const response = await api.request(`/sessions/${currentSession.session_id}/documents/${review.documentId}/pdf-review`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  sessionDocs[docKey].pdf_review = response;
  documentsIndex[currentSession.session_id] = sessionDocs;
  await storage.set({
    [storage.keys.DOCUMENTS]: documentsIndex,
  });
  highlightSummary.updateDocumentReview(review.documentId, response);
  setNotice("PDF review saved.");
  return response;
}

async function handleHtmlHighlightRemovalRequest(request) {
  const { highlight_id: highlightId, local_id: localId, document_url: documentUrl } = request || {};
  if (!currentSession) {
    chrome.runtime.sendMessage({
      type: "HTML_HIGHLIGHT_REMOVE_FAILED",
      payload: { local_id: localId, highlight_id: highlightId, reason: "No active session" },
    });
    setNotice("Start a session before removing highlights.", "error");
    return;
  }
  if (!highlightId) {
    console.debug("HTML highlight removal (local)", request);
    removeHighlightEntryById(null, localId || null);
    maybeClearActiveHighlight({ highlightId: null, localId: localId || null });
    chrome.runtime.sendMessage({
      type: "HTML_HIGHLIGHT_REMOVED",
      payload: { local_id: localId || null },
    });
    chrome.runtime.sendMessage({
      type: "PDF_HIGHLIGHT_CANCELLED",
      payload: { local_id: localId || null, url: documentUrl || currentTabInfo.url || "" },
    });
    setNotice("Highlight removed.");
    return;
  }
  const docUrl = documentUrl || currentTabInfo.url || "";
  try {
    console.debug("HTML highlight removal (saved)", request);
    await api.request(`/highlights/${highlightId}`, {
      method: "DELETE",
    });
    removeHighlightEntryById(highlightId, localId || null);
    await pruneHighlightFromDocuments(docUrl, highlightId, localId);
    maybeClearActiveHighlight({ highlightId, localId: localId || null });
    chrome.runtime.sendMessage({
      type: "HTML_HIGHLIGHT_REMOVED",
      payload: { local_id: localId || null, highlight_id: highlightId, document_url: docUrl },
    });
    chrome.runtime.sendMessage({
      type: "PDF_HIGHLIGHT_CANCELLED",
      payload: { local_id: localId || null, highlight_id: highlightId, url: docUrl },
    });
    setNotice("Highlight removed.");
  } catch (error) {
    console.error("Failed to remove highlight", error);
    chrome.runtime.sendMessage({
      type: "HTML_HIGHLIGHT_REMOVE_FAILED",
      payload: { local_id: localId || null, highlight_id: highlightId },
    });
    setNotice(error.message || "Failed to remove highlight.", "error");
  }
}

async function deleteHighlightFromSummary(entry) {
  if (!entry) {
    return;
  }
  await handleHtmlHighlightRemovalRequest({
    highlight_id: entry.highlightId || entry.id || null,
    local_id: entry.localId || null,
    document_url: entry.documentUrl || entry.url || "",
  });
}

function updateActiveCardSuggestions(resolvedSuggestions, options = {}) {
  const card = highlightContainer.querySelector(".highlight-card");
  if (!card) {
    return;
  }
  const { prefillReasoning = false } = options;
  const suggestionsSection = card.querySelector(".suggestions");
  const applySuggestion = typeof card.__applySuggestion === "function"
    ? card.__applySuggestion
    : (suggestion) => {
      const reasoningInput = card.querySelector(".reasoning-input");
      if (reasoningInput && suggestion?.detail) {
        reasoningInput.value = suggestion.detail;
      }
    };
  renderAiSuggestionsContent(suggestionsSection, resolvedSuggestions, {
    onSelect: applySuggestion,
    isLoading: false,
  });
  if (typeof card.__setAiLoadingState === "function") {
    card.__setAiLoadingState(false);
  }
  if (prefillReasoning) {
    const reasoningEl = card.querySelector(".reasoning-input");
    if (reasoningEl && !reasoningEl.value && resolvedSuggestions[0]?.detail) {
      reasoningEl.value = resolvedSuggestions[0].detail;
    }
  }
}

async function handleSelection(payload) {
  if (!currentSession) {
    setNotice("Start a session from the popup before highlighting.", "error");
    return;
  }

  try {
    const documentId = await ensureDocument(payload.meta);
    const docRecord = documentsIndex[currentSession.session_id][payload.meta.url];
    if (normalisePdfDocumentEntry(docRecord)) {
      await storage.set({
        [storage.keys.DOCUMENTS]: documentsIndex,
      });
    }
    const docType = payload.selector.type === "PDFText" ? "pdf" : payload.meta.type || docRecord.type || "html";
    docRecord.type = docType;
    documentsIndex[currentSession.session_id][payload.meta.url] = docRecord;
    await storage.set({
      [storage.keys.DOCUMENTS]: documentsIndex,
    });
    const selectionContext = payload.context || "";
    const highlightLabel =
      payload.sentiment
      || payload.user_judgment?.chosen_label
      || null;
    const documentTextForAi = docType === "pdf" ? payload.document_text || "" : "";
    const docMetaForAi = {
      title: payload.meta.title,
      url: payload.meta.url,
      type: docType,
      site: payload.meta.site || extractSiteFromUrl(payload.meta.url),
    };
    if (Array.isArray(payload.meta.links) && payload.meta.links.length > 0) {
      docMetaForAi.links = payload.meta.links;
    }
    const aiRequestBody = {
      highlight_text: payload.text,
      doc_meta: docMetaForAi,
      context: selectionContext,
      document_text: documentTextForAi,
      label: highlightLabel,
      mode: docType,
    };

    const documentMeta = {
      document_id: documentId,
      title: docRecord.title,
      url: payload.meta.url,
      accessed_at: docRecord.accessed_at,
      type: docType,
      global_judgment: docRecord.global_judgment || null,
      pdf_review: docRecord.pdf_review || null,
    };

    const selectionData = {
      text: payload.text,
      selector: payload.selector,
      suggestions: buildAiSuggestionSkeletons(),
      links: Array.isArray(payload.meta.links) ? payload.meta.links : [],
      context: selectionContext,
      sentiment: payload.sentiment || payload.user_judgment?.chosen_label || null,
      localId: payload.local_id || null,
      isAwaitingSuggestions: true,
      user_judgment: payload.user_judgment || null,
    };
    if (docType === "pdf") {
      const normalizedJudgment = normalisePdfUserJudgment(selectionData.user_judgment || {});
      const canonicalSentiment = ensurePdfSentiment(selectionData.sentiment || normalizedJudgment.chosen_label);
      selectionData.sentiment = canonicalSentiment;
      selectionData.user_judgment = {
        ...normalizedJudgment,
        chosen_label: canonicalSentiment,
      };
    }

    renderHighlightCard(selectionData, documentMeta);
    setNotice("Generating AI suggestions…");

    let suggestions = [];
    try {
      const suggestionsResponse = await api.request("/ai/suggestions", {
        method: "POST",
        body: JSON.stringify(aiRequestBody),
      });
      if (Array.isArray(suggestionsResponse.suggestions)) {
        suggestions = suggestionsResponse.suggestions;
      }
    } catch (suggestionError) {
      console.debug("AI suggestions unavailable", suggestionError);
    }

    const displaySuggestions = getDisplaySuggestions(suggestions, payload.text);
    selectionData.suggestions = displaySuggestions;
    selectionData.isAwaitingSuggestions = false;
    const shouldPrefillReasoning = docType === "pdf";
    updateActiveCardSuggestions(displaySuggestions, { prefillReasoning: shouldPrefillReasoning });
    if (docType === "pdf") {
      setNotice("Highlight key passages, capture reasoning, and save your insight.");
    } else {
      setNotice("Review AI suggestions, add reasoning, then save the highlight.");
    }
  } catch (error) {
    console.error("Failed handling selection", error);
    setNotice(error.message || "Unable to process selection.", "error");
  }
}

async function handleExport() {
  if (!currentSession) {
    setNotice("No session available to export.", "error");
    return;
  }
  try {
    const data = await api.request(`/export/${currentSession.session_id}`, {
      method: "GET",
    });
    openJson(data);
    setNotice("Export opened in a new tab.");
  } catch (error) {
    console.error("Failed to export", error);
    setNotice(error.message || "Export failed.", "error");
  }
}

exportButton.addEventListener("click", handleExport);

async function handleFinish() {
  if (!currentSession) {
    setNotice("No session available.", "error");
    return;
  }
  finishButton.disabled = true;
  setNotice("Finalizing session…");
  let completed = false;
  try {
    const completeResponse = await api.request(`/sessions/${currentSession.session_id}/complete`, {
      method: "POST",
    });
    currentSession.end_time = completeResponse.ended_at;
    await storage.set({
      [storage.keys.SESSION]: currentSession,
    });
    const data = await api.request(`/export/${currentSession.session_id}`, {
      method: "GET",
    });
    openJson(data);
    setNotice(`Session completed. Export downloaded at ${formatDate(completeResponse.ended_at)}.`);
    completed = true;
  } catch (error) {
    console.error("Failed to complete session", error);
    setNotice(error.message || "Failed to complete session.", "error");
  } finally {
    if (!completed) {
      finishButton.disabled = false;
    }
  }
}

finishButton.addEventListener("click", handleFinish);

function addHighlightToSummary(documentMeta, selection) {
  if (!highlightSummary) {
    return;
  }
  const rect = Array.isArray(selection.selector?.rects) ? selection.selector.rects[0] : null;
  const fingerprint = rect
    ? [rect.x1, rect.y1, rect.x2, rect.y2].map((v) => Number(v).toFixed(2)).join(":")
    : null;
  highlightSummary.add({
    id: selection.id || selection.highlightId || selection.localId || `${documentMeta.document_id}-hl-${Date.now()}`,
    highlightId: selection.highlightId || selection.id || null,
    localId: selection.localId || null,
    documentId: documentMeta.document_id,
    documentTitle: documentMeta.title || documentMeta.url,
    documentUrl: documentMeta.url,
    documentType: documentMeta.type,
    documentSentiment: documentMeta.pdf_review?.sentiment || null,
    documentReview: documentMeta.pdf_review || null,
    url: documentMeta.url,
    title: documentMeta.title || documentMeta.url,
    type: documentMeta.type,
    page: selection.selector?.page || null,
    text: selection.text?.slice(0, 160) || "",
    saved: Boolean(selection.saved),
    fingerprint,
    selector: selection.selector,
    user_judgment: selection.user_judgment || {},
    ai_suggestions: selection.ai_suggestions || [],
    context: selection.context || null,
    rank: documentMeta.pdf_review?.highlight_order && selection.highlightId
      ? documentMeta.pdf_review.highlight_order.indexOf(selection.highlightId) + 1 || null
      : null,
  });
}

function removeHighlightFromSummary(url, page, fingerprint) {
  if (!highlightSummary) {
    return;
  }
  highlightSummary.remove((item) => {
    if (item.url !== url) {
      return false;
    }
    if (fingerprint && item.fingerprint) {
      return item.fingerprint === fingerprint;
    }
    if (page && item.page && Math.abs(item.page - page) < 0.01) {
      return true;
    }
    return false;
  });
}

function removeHighlightEntryById(highlightId, localId = null) {
  if (!highlightSummary) {
    return;
  }
  highlightSummary.remove((item) => {
    if (highlightId && item.highlightId && item.highlightId === highlightId) {
      return true;
    }
    if (highlightId && item.id === highlightId) {
      return true;
    }
    if (localId && item.localId && item.localId === localId) {
      return true;
    }
    return false;
  });
}

async function pruneHighlightFromDocuments(documentUrl, highlightId, localId = null) {
  if (!currentSession) {
    return;
  }
  const sessionDocs = documentsIndex[currentSession.session_id] || {};
  const docEntry = sessionDocs[documentUrl];
  if (!docEntry) {
    return;
  }
  if (Array.isArray(docEntry.highlights) && highlightId) {
    docEntry.highlights = docEntry.highlights.filter((h) => h.highlight_id !== highlightId);
  }
  if (docEntry.pdf_review && Array.isArray(docEntry.pdf_review.highlight_order) && highlightId) {
    docEntry.pdf_review.highlight_order = docEntry.pdf_review.highlight_order.filter((id) => id !== highlightId);
  }
  sessionDocs[documentUrl] = docEntry;
  documentsIndex[currentSession.session_id] = sessionDocs;
  await storage.set({
    [storage.keys.DOCUMENTS]: documentsIndex,
  });
}

function openHighlightEditor(entry) {
  if (!entry) {
    return;
  }
  const sessionId = currentSession?.session_id;
  if (!sessionId) {
    setNotice("Start a session to edit highlights.", "error");
    return;
  }
  const docs = documentsIndex[sessionId] || {};
  const docRecord = Object.values(docs).find((doc) => doc.document_id === entry.documentId) || docs[entry.url];
  if (!docRecord) {
    setNotice("Cannot locate document for this highlight.", "error");
    return;
  }
  const selection = {
    text: entry.text,
    selector: entry.selector || { type: entry.type === "pdf" ? "PDFText" : "TextQuote" },
    suggestions: entry.ai_suggestions || [],
    links: [],
    user_judgment: entry.user_judgment || {},
    highlightId: entry.highlightId || entry.id,
    fingerprint: entry.fingerprint || null,
    context: entry.context || "",
    sentiment: entry.user_judgment?.chosen_label || null,
  };
  renderHighlightCard(selection, {
    document_id: entry.documentId,
    title: entry.title,
    url: entry.url,
    type: entry.type,
    accessed_at: docRecord.accessed_at,
    global_judgment: docRecord.global_judgment || null,
  });
  setNotice("Loaded highlight for editing. Update reasoning and save.");
}

function updatePdfButtonState() {
  if (!currentSession) {
    pdfButton.disabled = true;
    currentTabInfo = { url: "", title: "" };
    currentPdfCandidate = null;
    return;
  }
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || tabs.length === 0) {
      pdfButton.disabled = true;
      currentPdfCandidate = null;
      return;
    }
    const tab = tabs[0];
    currentTabInfo = { url: tab.url || "", title: tab.title || "" };
    currentPdfCandidate = derivePdfCandidate(tab.url || "");
    pdfButton.disabled = !currentPdfCandidate;
  });
}

pdfButton.addEventListener("click", () => {
  if (pdfButton.disabled || !currentSession) {
    setNotice("Start a session before opening PDF mode.", "error");
    return;
  }
  if (!currentPdfCandidate) {
    setNotice("No PDF detected on this tab.", "error");
    return;
  }
  chrome.runtime.sendMessage({
    type: "OPEN_PDF_VIEWER",
    payload: {
      url: currentPdfCandidate,
      title: currentTabInfo.title || "PDF Document",
    },
  });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "FORWARD_SELECTION") {
    handleSelection(message.payload);
  } else if (message.type === "SESSION_STARTED") {
    loadState();
  } else if (message.type === "SESSION_RESET") {
    currentSession = null;
    documentsIndex = {};
    sessionInfoEl.textContent = "No active session";
    exportButton.disabled = true;
    finishButton.disabled = true;
    clearHighlights();
    setNotice("Session reset. Start a new session from the popup.", "error");
  } else if (message.type === "SEARCH_RECORDED") {
    const { platform, query } = message.payload;
    const label = platform === "google_scholar" ? "Google Scholar" : "Semantic Scholar";
    setNotice(`Recorded search on ${label}: "${query}"`);
  } else if (message.type === "DOCUMENT_SUMMARY_SAVED") {
    const sessionId = currentSession?.session_id;
    if (!sessionId) {
      return;
    }
    const entry = documentsIndex[sessionId]?.[message.payload.url];
    if (entry) {
      const nextSummary = message.payload.global_judgment || null;
      const currentSummary = entry.global_judgment || null;
      if (JSON.stringify(currentSummary) !== JSON.stringify(nextSummary)) {
        entry.global_judgment = nextSummary;
        if (highlightSummary && entry.document_id) {
          highlightSummary.updateDocumentSummary(entry.document_id, entry.global_judgment || null);
        }
        storage.set({
          [storage.keys.DOCUMENTS]: documentsIndex,
        });
      }
    }
  } else if (message.type === "PDF_HIGHLIGHT_CANCELLED") {
    const sessionId = currentSession?.session_id;
    if (!sessionId) {
      return;
    }
    const payload = message.payload || {};
    const docUrl = payload.url || currentTabInfo.url || "";
    removeHighlightEntryById(payload.highlight_id || null, payload.local_id || null);
    clearHighlights();
    setNotice("Highlight removed. Select text again to annotate.");
    if (docUrl) {
      pruneHighlightFromDocuments(docUrl, payload.highlight_id || null, payload.local_id || null).catch((error) => {
        console.debug("Failed to prune highlight from document cache", error);
      });
    }
  } else if (message.type === "HTML_HIGHLIGHT_REMOVE_REQUEST") {
    handleHtmlHighlightRemovalRequest(message.payload);
  } else if (message.type === "HTML_HIGHLIGHT_REMOVED") {
    const payload = message.payload || {};
    console.debug("HTML highlight removal confirmed", payload);
    removeHighlightEntryById(payload.highlight_id || null, payload.local_id || null);
    clearHighlights();
    setNotice("Highlight removed.");
  } else if (message.type === "HTML_HIGHLIGHT_REMOVE_FAILED") {
    setNotice("Failed to remove highlight.", "error");
  } else if (message.type === "PDF_REVIEW_SAVED") {
    const sessionId = currentSession?.session_id;
    if (!sessionId) {
      return;
    }
    const payload = message.payload || {};
    const docUrl = payload.url || currentTabInfo.url || "";
    const sessionDocs = documentsIndex[sessionId] || {};
    let docKey = docUrl && sessionDocs[docUrl] ? docUrl : null;
    if (!docKey && payload.document_id) {
      docKey = Object.keys(sessionDocs).find((key) => sessionDocs[key].document_id === payload.document_id) || null;
    }
    if (!docKey) {
      return;
    }
    const docEntry = sessionDocs[docKey];
    normalisePdfDocumentEntry(docEntry);
    const highlightOrder = Array.isArray(payload.highlight_order) ? payload.highlight_order : [];
    docEntry.pdf_review = {
      sentiment: ensurePdfSentiment(payload.sentiment || docEntry.pdf_review?.sentiment),
      highlight_order: highlightOrder,
    };
    if (Array.isArray(docEntry.highlights)) {
      const map = new Map();
      docEntry.highlights.forEach((highlight) => {
        if (highlight.highlight_id) {
          map.set(highlight.highlight_id, highlight);
        }
      });
      const reordered = [];
      const used = new Set();
      highlightOrder.forEach((id) => {
        if (map.has(id) && !used.has(id)) {
          reordered.push(map.get(id));
          used.add(id);
        }
      });
      docEntry.highlights.forEach((highlight) => {
        const id = highlight.highlight_id;
        if (!id || !used.has(id)) {
          reordered.push(highlight);
        }
      });
      docEntry.highlights = reordered;
    }
    normalisePdfDocumentEntry(docEntry);
    sessionDocs[docKey] = docEntry;
    documentsIndex[sessionId] = sessionDocs;
    storage.set({
      [storage.keys.DOCUMENTS]: documentsIndex,
    });
    if (highlightSummary && docEntry.document_id) {
      highlightSummary.updateDocumentReview(docEntry.document_id, docEntry.pdf_review);
    }
    setNotice("Highlight order updated.");
  }

});

chrome.tabs.onActivated.addListener(updatePdfButtonState);
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.active && (changeInfo.status === "complete" || changeInfo.url)) {
    updatePdfButtonState();
  }
});

loadState();
