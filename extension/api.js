if (!window.EXPERT_ANNOTATOR) {
  (function initializeApiLayer() {
    const API_BASE_URL = "http://127.0.0.1:8000";

    const STORAGE_KEYS = {
      SESSION: "session",
      DOCUMENTS: "documents",
      TRAJECTORY: "trajectory",
      ONBOARDING: "onboarding",
    };

    async function apiRequest(path, options = {}) {
      const url = `${API_BASE_URL}${path}`;
      const defaultHeaders = {
        "Content-Type": "application/json",
      };
      const config = {
        ...options,
        headers: {
          ...defaultHeaders,
          ...(options.headers || {}),
        },
      };

      const response = await fetch(url, config);
      if (!response.ok) {
        const message = await response.text();
        throw new Error(
          `API ${response.status} ${response.statusText}: ${message || "Unknown error"}`
        );
      }
      if (response.status === 204) {
        return null;
      }
      return response.json();
    }

    function storageGet(keys) {
      return new Promise((resolve) => {
        chrome.storage.local.get(keys, resolve);
      });
    }

    function storageSet(items) {
      return new Promise((resolve) => {
        chrome.storage.local.set(items, resolve);
      });
    }

    function storageRemove(keys) {
      return new Promise((resolve) => {
        chrome.storage.local.remove(keys, resolve);
      });
    }

    function openJsonInNewTab(data) {
      const pretty = JSON.stringify(data, null, 2);
      const encoded = encodeURIComponent(pretty);
      const url = `data:application/json;charset=utf-8,${encoded}`;
      chrome.tabs.create({ url });
    }

    function downloadJsonFile(filename, data) {
      const pretty = JSON.stringify(data, null, 2);
      const blob = new Blob([pretty], { type: "application/json" });
      const downloadUrl = URL.createObjectURL(blob);
      chrome.downloads.download(
        {
          url: downloadUrl,
          filename,
        },
        () => {
          setTimeout(() => URL.revokeObjectURL(downloadUrl), 10_000);
        }
      );
    }

    const apiExports = {
      api: {
        BASE_URL: API_BASE_URL,
        request: apiRequest,
      },
      storage: {
        get: storageGet,
        set: storageSet,
        remove: storageRemove,
        keys: STORAGE_KEYS,
      },
      openJsonInNewTab,
      downloadJsonFile,
    };

    window.EXPERT_ANNOTATOR = Object.freeze(apiExports);
  })();
}
