const { api, storage } = window.EXPERT_ANNOTATOR;
const openJson = window.EXPERT_ANNOTATOR.openJsonInNewTab;

const sessionForm = document.getElementById("session-form");
const startSection = document.getElementById("start-session-section");
const activeSection = document.getElementById("active-session-section");
const statusMessage = document.getElementById("status-message");
const sessionSummary = document.getElementById("session-summary");
const exportBtn = document.getElementById("export-btn");
const resetBtn = document.getElementById("reset-btn");

let currentSession = null;
let documentsIndex = {};

function setStatus(message, isError = false) {
  statusMessage.textContent = message;
  statusMessage.style.color = isError ? "#d93025" : "#5f6368";
}

async function loadState() {
  const stored = await storage.get([storage.keys.SESSION, storage.keys.DOCUMENTS]);
  currentSession = stored[storage.keys.SESSION] || null;
  documentsIndex = stored[storage.keys.DOCUMENTS] || {};
  render();
}

function render() {
  if (currentSession) {
    startSection.hidden = true;
    activeSection.hidden = false;
    const startedAt = new Date(currentSession.start_time);
    sessionSummary.innerHTML = `
      <strong>${currentSession.expert_name}</strong><br />
      Topic: ${currentSession.topic}<br />
      Goal: ${currentSession.research_goal}<br />
      Started: ${startedAt.toLocaleString()}
    `;
    setStatus("Session active. Select text on any page to annotate.");
  } else {
    startSection.hidden = false;
    activeSection.hidden = true;
    setStatus("Start a new session to capture highlights.");
  }
}

async function handleSessionSubmit(event) {
  event.preventDefault();
  setStatus("Creating session…");

  const formData = new FormData(sessionForm);
  const payload = {
    expert_name: formData.get("expert_name")?.toString().trim() || "",
    topic: formData.get("topic")?.toString().trim() || "",
    research_goal: formData.get("research_goal")?.toString().trim() || "",
  };

  if (!payload.expert_name || !payload.topic || !payload.research_goal) {
    setStatus("All fields are required.", true);
    return;
  }

  try {
    const session = await api.request("/sessions", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    currentSession = session;
    documentsIndex = {
      [session.session_id]: {},
    };
    await storage.set({
      [storage.keys.SESSION]: session,
      [storage.keys.DOCUMENTS]: documentsIndex,
    });
    chrome.runtime.sendMessage({ type: "SESSION_STARTED" });
    sessionForm.reset();
    setStatus("Session created. Side panel will capture highlights.");
    render();
  } catch (error) {
    console.error("Failed to create session", error);
    setStatus(error.message || "Failed to create session.", true);
  }
}

async function handleExport() {
  if (!currentSession) {
    setStatus("Start a session first.", true);
    return;
  }
  setStatus("Exporting session…");
  try {
    const data = await api.request(`/export/${currentSession.session_id}`, {
      method: "GET",
    });
    openJson(data);
    setStatus("Export opened in a new tab.");
  } catch (error) {
    console.error("Export failed", error);
    setStatus(error.message || "Export failed.", true);
  }
}

async function handleReset() {
  await storage.remove([storage.keys.SESSION, storage.keys.DOCUMENTS]);
  currentSession = null;
  documentsIndex = {};
  chrome.runtime.sendMessage({ type: "SESSION_RESET" });
  render();
  setStatus("Session reset. Start a new session when ready.");
}

sessionForm.addEventListener("submit", handleSessionSubmit);
exportBtn.addEventListener("click", handleExport);
resetBtn.addEventListener("click", handleReset);

loadState();
