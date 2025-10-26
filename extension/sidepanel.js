const { api, storage } = window.EXPERT_ANNOTATOR;
const openJson = window.EXPERT_ANNOTATOR.openJsonInNewTab;

const noticeEl = document.getElementById("notice");
const sessionInfoEl = document.getElementById("session-info");
const highlightContainer = document.getElementById("highlight-container");
const exportButton = document.getElementById("export-btn");
const template = document.getElementById("highlight-template");

let currentSession = null;
let documentsIndex = {};

function setNotice(message, tone = "info") {
  noticeEl.textContent = message;
  noticeEl.classList.toggle("error", tone === "error");
  noticeEl.hidden = !message;
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

  if (currentSession) {
    sessionInfoEl.textContent = `${currentSession.expert_name} · ${currentSession.topic}`;
    exportButton.disabled = false;
    setNotice("Select text in the active tab to generate highlights.");
  } else {
    sessionInfoEl.textContent = "No active session";
    exportButton.disabled = true;
    setNotice("Start a session from the popup before highlighting.", "error");
    clearHighlights();
  }
}

async function ensureDocument(meta) {
  if (!currentSession) {
    throw new Error("No active session");
  }
  const sessionId = currentSession.session_id;
  const sessionDocs = documentsIndex[sessionId] || {};

  if (sessionDocs[meta.url]) {
    return sessionDocs[meta.url].document_id;
  }

  const document = await api.request(`/sessions/${sessionId}/documents`, {
    method: "POST",
    body: JSON.stringify({
      title: meta.title || meta.url,
      url: meta.url,
      type: "html",
      accessed_at: meta.accessed_at,
    }),
  });

  documentsIndex[sessionId] = {
    ...sessionDocs,
    [meta.url]: {
      document_id: document.document_id,
      title: document.title,
      accessed_at: document.accessed_at,
    },
  };

  await storage.set({
    [storage.keys.DOCUMENTS]: documentsIndex,
  });

  return document.document_id;
}

function clearHighlights() {
  highlightContainer.innerHTML = "";
}

function renderHighlightCard(selection, documentMeta) {
  clearHighlights();

  const fragment = template.content.cloneNode(true);
  const card = fragment.querySelector(".highlight-card");
  const titleEl = fragment.querySelector(".doc-title");
  const urlEl = fragment.querySelector(".doc-url");
  const capturedAtEl = fragment.querySelector(".captured-at");
  const selectedTextEl = fragment.querySelector(".selected-text");
  const suggestionsList = fragment.querySelector(".suggestions ul");
  const selectEl = fragment.querySelector(".label-select");
  const reasoningEl = fragment.querySelector(".reasoning-input");
  const confidenceEl = fragment.querySelector(".confidence-input");
  const saveBtn = fragment.querySelector(".save-btn");
  const saveStatusEl = fragment.querySelector(".save-status");

  titleEl.textContent = documentMeta.title || "Untitled document";
  urlEl.textContent = documentMeta.url;
  urlEl.href = documentMeta.url;
  capturedAtEl.textContent = `Accessed: ${formatDate(documentMeta.accessed_at)}`;
  selectedTextEl.textContent = selection.text;

  suggestionsList.innerHTML = "";
  selection.suggestions.forEach((suggestion) => {
    const li = document.createElement("li");
    li.textContent = suggestion;
    suggestionsList.appendChild(li);
  });

  reasoningEl.value = selection.suggestions[0] || "";

  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    saveStatusEl.textContent = "Saving…";
    saveStatusEl.classList.remove("success", "error");

    const confidenceValue = confidenceEl.value.trim();
    const confidence = confidenceValue ? Number(confidenceValue) : null;

    const payload = {
      text: selection.text,
      selector: selection.selector,
      ai_suggestions: selection.suggestions,
      user_judgment: {
        chosen_label: selectEl.value,
        reasoning: reasoningEl.value.trim(),
        confidence,
      },
    };

    try {
      const response = await api.request(
        `/sessions/${currentSession.session_id}/documents/${documentMeta.document_id}/highlights`,
        {
          method: "POST",
          body: JSON.stringify(payload),
        }
      );
      saveStatusEl.textContent = `Saved (ID: ${response.highlight_id})`;
      saveStatusEl.classList.add("success");
    } catch (error) {
      console.error("Failed to save highlight", error);
      saveStatusEl.textContent = error.message || "Failed to save highlight.";
      saveStatusEl.classList.add("error");
    } finally {
      saveBtn.disabled = false;
    }
  });

  highlightContainer.appendChild(fragment);
}

async function handleSelection(payload) {
  if (!currentSession) {
    setNotice("Start a session from the popup before highlighting.", "error");
    return;
  }

  try {
    const documentId = await ensureDocument(payload.meta);
    const docRecord = documentsIndex[currentSession.session_id][payload.meta.url];
    const suggestionsResponse = await api.request("/ai/suggestions", {
      method: "POST",
      body: JSON.stringify({
        highlight_text: payload.text,
        doc_meta: {
          title: payload.meta.title,
          url: payload.meta.url,
        },
      }),
    });

    renderHighlightCard(
      {
        text: payload.text,
        selector: payload.selector,
        suggestions: suggestionsResponse.suggestions,
      },
      {
        document_id: documentId,
        title: docRecord.title,
        url: payload.meta.url,
        accessed_at: docRecord.accessed_at,
      }
    );
    setNotice("Review the AI suggestions, adjust, and save the highlight.");
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
    clearHighlights();
    setNotice("Session reset. Start a new session from the popup.", "error");
  }
});

loadState();
