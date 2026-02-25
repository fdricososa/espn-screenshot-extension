const statusEl = document.getElementById("status");
const btn = document.getElementById("capture");

function setStatus(msg) {
  statusEl.textContent = msg;
}

btn.addEventListener("click", async () => {
  setStatus("Starting…");

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) {
    setStatus("No active tab.");
    return;
  }

  chrome.runtime.sendMessage(
    { type: "CAPTURE_MATCH", tabId: tab.id, url: tab.url },
    (resp) => {
      if (chrome.runtime.lastError) {
        setStatus("Error: " + chrome.runtime.lastError.message);
        return;
      }
      if (!resp?.ok) {
        setStatus("Error: " + (resp?.error || "unknown"));
        return;
      }
      setStatus("Done ✅ Downloads started.");
      window.close();
    }
  );
});