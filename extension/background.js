/* global chrome */

const API_BASE_URL = "http://127.0.0.1:8000";
const lastSearchByTab = new Map();
const TRAJECTORY_KEY = "trajectory";

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
      const timestamp = new Date().toISOString();
      const baseEpisode = {
        platform: message.payload.platform,
        query: message.payload.query,
        timestamp,
        episode_id: `${timestamp}-${message.payload.platform}`,
      };
      postJson(`/sessions/${session.session_id}/search-episodes`, {
        platform: message.payload.platform,
        query: message.payload.query,
        timestamp,
      })
        .then((response) => {
          const episodeRecord = {
            ...baseEpisode,
            episode_id: response?.episode_id || baseEpisode.episode_id,
          };
          appendSearchEpisode(session.session_id, episodeRecord);
          chrome.runtime.sendMessage({
            type: "SEARCH_RECORDED",
            payload: episodeRecord,
          });
        })
        .catch((error) => {
          console.error("Failed to record search episode", error);
          appendSearchEpisode(session.session_id, baseEpisode);
          chrome.runtime.sendMessage({
            type: "SEARCH_RECORDED",
            payload: baseEpisode,
          });
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
      const timestamp = new Date().toISOString();
      const baseEntry = {
        type: message.payload.type,
        url: message.payload.url,
        title: message.payload.title,
        context: message.payload.context,
        timestamp,
        interaction_id: `${message.payload.type}-${timestamp}`,
      };
      postJson(`/sessions/${session.session_id}/interactions`, {
        interaction_type: message.payload.type,
        payload: {
          url: message.payload.url,
          title: message.payload.title,
          context: message.payload.context,
        },
        timestamp,
      })
        .then((response) => {
          const entry = {
            ...baseEntry,
            interaction_id: response?.interaction_id || baseEntry.interaction_id,
          };
          appendInteraction(session.session_id, entry);
          chrome.runtime.sendMessage({
            type: "TRAJECTORY_INTERACTION_RECORDED",
            payload: entry,
          });
        })
        .catch((error) => {
          console.error("Failed to record interaction", error);
          appendInteraction(session.session_id, baseEntry);
          chrome.runtime.sendMessage({
            type: "TRAJECTORY_INTERACTION_RECORDED",
            payload: baseEntry,
          });
        });
    });
    return;
  }

  if (message.type === "OPEN_PDF_VIEWER") {
    const { url, title, source } = message.payload || {};
    if (!url) {
      return;
    }
    openPdfViewer(url, title || "");
    if (source !== "sidepanel") {
      return;
    }
    const sessionPromise = getSessionState();
    sessionPromise.then((session) => {
      if (!session || !session.session_id) {
        return;
      }
      const timestamp = new Date().toISOString();
      const baseEntry = {
        type: "pdf_viewer_opened",
        url,
        title: title || "",
        timestamp,
        interaction_id: `pdf-${timestamp}`,
      };
      postJson(`/sessions/${session.session_id}/interactions`, {
        interaction_type: "pdf_viewer_opened",
        payload: {
          url,
          title: title || "",
        },
        timestamp,
      })
        .then((response) => {
          const entry = {
            ...baseEntry,
            interaction_id: response?.interaction_id || baseEntry.interaction_id,
          };
          appendInteraction(session.session_id, entry);
          chrome.runtime.sendMessage({
            type: "TRAJECTORY_INTERACTION_RECORDED",
            payload: entry,
          });
        })
        .catch((error) => {
          console.error("Failed to record PDF interaction", error);
          appendInteraction(session.session_id, baseEntry);
          chrome.runtime.sendMessage({
            type: "TRAJECTORY_INTERACTION_RECORDED",
            payload: baseEntry,
          });
        });
    });
    return;
  }

  if (message.type === "SCHOLAR_CONTEXT_DETECTED") {
    chrome.runtime.sendMessage({ type: "SCHOLAR_CONTEXT_DETECTED" });
    return;
  }

  if (message.type === "SESSION_RESET") {
    lastSearchByTab.clear();
    chrome.storage.local.set({ [TRAJECTORY_KEY]: {} });
  }
});
function updateTrajectory(sessionId, mutator) {
  if (!sessionId) {
    return;
  }
  chrome.storage.local.get([TRAJECTORY_KEY], (result) => {
    const data = result[TRAJECTORY_KEY] || {};
    const existing = data[sessionId] || { searchEpisodes: [], interactions: [] };
    mutator(existing);
    data[sessionId] = existing;
    chrome.storage.local.set({ [TRAJECTORY_KEY]: data });
  });
}

function appendSearchEpisode(sessionId, entry) {
  updateTrajectory(sessionId, (existing) => {
    const next = [entry, ...(existing.searchEpisodes || [])];
    existing.searchEpisodes = next.slice(0, 50);
    existing.interactions = existing.interactions || [];
  });
}

function appendInteraction(sessionId, entry) {
  updateTrajectory(sessionId, (existing) => {
    const next = [entry, ...(existing.interactions || [])];
    existing.interactions = next.slice(0, 50);
    existing.searchEpisodes = existing.searchEpisodes || [];
  });
}
