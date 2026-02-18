function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function extractGameId(url) {
  // ESPN URLs often contain ".../gameId/401850949" (your example)
  const m = url.match(/gameId\/(\d+)/i);
  return m ? m[1] : null;
}

function buildUrls(gameId) {
  return {
    commentary: `https://www.espn.com/soccer/commentary/_/gameId/${gameId}`,
    stats: `https://www.espn.com/soccer/matchstats/_/gameId/${gameId}`
  };
}

async function captureVisible(tabId) {
  const tab = await chrome.tabs.get(tabId);
  // captureVisibleTab requires windowId
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  return dataUrl;
}

async function downloadDataUrl(dataUrl, filename) {
  await chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: false
  });
}

async function loadUrlInTab(tabId, url) {
  await chrome.tabs.update(tabId, { url });
}

async function waitForTabComplete(tabId, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return;
    await sleep(250);
  }
  throw new Error("Timeout waiting for page load.");
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.type !== "CAPTURE_BOTH") return;

    const { tabId, url } = msg;
    const gameId = extractGameId(url);
    if (!gameId) {
      sendResponse({ ok: false, error: "No gameId found in current URL." });
      return;
    }

    const { commentary, stats } = buildUrls(gameId);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");

    // 1) Commentary
    await loadUrlInTab(tabId, commentary);
    await waitForTabComplete(tabId);
    await sleep(800); // let dynamic content settle a bit
    const commShot = await captureVisible(tabId);
    await downloadDataUrl(commShot, `espn_${gameId}_commentary_${stamp}.png`);

    // 2) Stats
    await loadUrlInTab(tabId, stats);
    await waitForTabComplete(tabId);
    await sleep(800);
    const statsShot = await captureVisible(tabId);
    await downloadDataUrl(statsShot, `espn_${gameId}_stats_${stamp}.png`);

    sendResponse({ ok: true });
  })().catch((e) => {
    console.error(e);
    sendResponse({ ok: false, error: e?.message || String(e) });
  });

  // Keep message channel open for async response
  return true;
});