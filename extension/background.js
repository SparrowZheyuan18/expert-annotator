/* global chrome */

const API_BASE_URL = "http://127.0.0.1:8000";
const lastSearchByTab = new Map();

console.log("Expert Annotator background service worker initialized.");

chrome.runtime.onInstalled.addListener(() => {
  console.log("Expert Annotator extension installed.");
});

function postJson(path, payload) {
  const url = `${API_BASE_URL}${path}`;
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  }).then(async (response) => {
    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || `API error ${response.status}`);
    }
    return response.json();
  });
}

function getSessionState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["session"], (result) => {
      resolve(result.session || null);
    });
  });
}

async function ensureSidePanel(tabId) {
  try {
    await chrome.sidePanel.open({ tabId });
  } catch (error) {
    console.debug("Side panel open skipped:", error?.message || error);
  }
}

function openPdfViewer(url, title) {
  const viewerUrl = chrome.runtime.getURL(
    `pdf_viewer.html?src=${encodeURIComponent(url)}&title=${encodeURIComponent(title || "")}`
  );
  chrome.tabs.create({ url: viewerUrl });
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message) {
    return;
  }

  if (message.type === "CONTENT_SELECTION" && sender.tab) {
    ensureSidePanel(sender.tab.id);
    chrome.runtime.sendMessage({
      type: "FORWARD_SELECTION",
      payload: {
        ...message.payload,
        tabId: sender.tab.id,
      },
    });
    return;
  }

  if (message.type === "CONTENT_HIGHLIGHT_REMOVE_REQUEST" && sender.tab) {
    ensureSidePanel(sender.tab.id);
    chrome.runtime.sendMessage({
      type: "HTML_HIGHLIGHT_REMOVE_REQUEST",
      payload: {
        ...message.payload,
        tabId: sender.tab.id,
      },
    });
    return;
  }

  if (message.type === "PDF_SELECTION" && sender.tab) {
    ensureSidePanel(sender.tab.id);
    chrome.runtime.sendMessage({
      type: "FORWARD_SELECTION",
      payload: {
        ...message.payload,
        tabId: sender.tab.id,
      },
    });
    return;
  }

  if (message.type === "PDF_HIGHLIGHT_CREATED") {
    chrome.runtime.sendMessage({
      type: "PDF_HIGHLIGHT_CREATED",
      payload: message.payload,
    });
    return;
  }

  if (message.type === "PDF_HIGHLIGHT_CANCELLED") {
    chrome.runtime.sendMessage({
      type: "PDF_HIGHLIGHT_CANCELLED",
      payload: message.payload,
    });
    return;
  }

  if (message.type === "SEARCH_QUERY" && sender.tab) {
    const sessionPromise = getSessionState();
    sessionPromise.then((session) => {
      if (!session || !session.session_id) {
        return;
      }
      const previous = lastSearchByTab.get(sender.tab.id);
      if (previous && previous.query === message.payload.query && previous.platform === message.payload.platform) {
        return;
      }
      lastSearchByTab.set(sender.tab.id, {
        platform: message.payload.platform,
        query: message.payload.query,
      });
      postJson(`/sessions/${session.session_id}/search-episodes`, {
        platform: message.payload.platform,
        query: message.payload.query,
        timestamp: new Date().toISOString(),
      })
        .then(() => {
          chrome.runtime.sendMessage({
            type: "SEARCH_RECORDED",
            payload: {
              platform: message.payload.platform,
              query: message.payload.query,
            },
          });
        })
        .catch((error) => {
          console.error("Failed to record search episode", error);
        });
    });
    return;
  }

  if (message.type === "SEARCH_INTERACTION" && sender.tab) {
    const sessionPromise = getSessionState();
    sessionPromise.then((session) => {
      if (!session || !session.session_id) {
        return;
      }
      postJson(`/sessions/${session.session_id}/interactions`, {
        interaction_type: message.payload.type,
        payload: {
          url: message.payload.url,
          title: message.payload.title,
          context: message.payload.context,
        },
        timestamp: new Date().toISOString(),
      }).catch((error) => {
        console.error("Failed to record interaction", error);
      });
    });
    return;
  }

  if (message.type === "OPEN_PDF_VIEWER") {
    openPdfViewer(message.payload.url, message.payload.title || "");
    return;
  }

  if (message.type === "SESSION_RESET") {
    lastSearchByTab.clear();
  }
});
