/* global chrome */

console.log("Expert Annotator background service worker initialized.");

chrome.runtime.onInstalled.addListener(() => {
  console.log("Expert Annotator extension installed.");
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || message.type === "FORWARD_SELECTION") {
    return;
  }

  if (message.type === "CONTENT_SELECTION" && sender.tab) {
    chrome.sidePanel
      .open({ tabId: sender.tab.id })
      .catch((error) => console.debug("Side panel open skipped:", error));

    chrome.runtime.sendMessage({
      type: "FORWARD_SELECTION",
      payload: {
        ...message.payload,
        tabId: sender.tab.id,
      },
    });
  }
});
