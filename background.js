function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

//RUN FUNCTION IN CURRENT TAB
async function execInTab(tabId, func, args = []) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
  });
  return result;
}

//LOCATOR FOR CONTAINERS
function locatePageLayoutMain() {
  const el = document.querySelector(".PageLayout__Main");
  if (!el) return null;

  el.scrollIntoView({ block: "start" });

  const r = el.getBoundingClientRect();
  return {
    pageTop: r.top + window.scrollY,
    height: Math.max(el.scrollHeight || 0, r.height || 0),
    viewportH: window.innerHeight,
  };
}

//GET MULTIPLE VIEWPORTS OF CONTAINERS
async function captureSectionSlices(tabId, locateFn, opts = {}) {
  const {
    settleMsAfterLocate = 250,
    settleMsAfterScroll = 450,
    maxSlices = 30,
    minIntervalBetweenCapturesMs = 650,
  } = opts;

  const info = await execInTab(tabId, locateFn);
  if (!info) throw new Error("Section not found (locator returned null).");
  if (typeof info.pageTop !== "number" || typeof info.height !== "number") {
    throw new Error("Locator must return { pageTop, height, viewportH }");
  }

  const startY = Math.max(0, Math.floor(info.pageTop));
  const totalH = Math.max(1, Math.floor(info.height));
  const viewportH = Math.max(1, Math.floor(info.viewportH || 1));

  await sleep(settleMsAfterLocate);

  const slicesNeeded = Math.min(maxSlices, Math.ceil(totalH / viewportH));
  const tab = await chrome.tabs.get(tabId);

  const urls = [];
  let dy = 0;
  let lastCaptureAt = 0;

  for (let i = 0; i < slicesNeeded; i++) {
    const y = startY + dy;

    // scroll window
    await execInTab(tabId, (yy) => window.scrollTo(0, yy), [y]);
    await sleep(settleMsAfterScroll);

    // throttle (avoid quota)
    const now = Date.now();
    const waitMs = Math.max(
      0,
      minIntervalBetweenCapturesMs - (now - lastCaptureAt)
    );
    if (waitMs) await sleep(waitMs);

    // capture visible viewport
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "png",
    });
    lastCaptureAt = Date.now();

    urls.push(dataUrl);

    dy += viewportH;
    if (dy >= totalH) break;
  }

  return urls;
}

//STITCH SLICES INTO ONE PNG
async function stitchSlices(slices) {
  if (!slices || slices.length === 0) throw new Error("No slices to stitch");

  // Decode all slices to bitmaps
  const bitmaps = [];
  for (const s of slices) {
    const blob = await (await fetch(s)).blob();
    const bmp = await createImageBitmap(blob);
    bitmaps.push(bmp);
  }

  const width = bitmaps[0].width;
  const totalHeight = bitmaps.reduce((sum, bmp) => sum + bmp.height, 0);

  const canvas = new OffscreenCanvas(width, totalHeight);
  const ctx = canvas.getContext("2d");

  let y = 0;
  for (const bmp of bitmaps) {
    ctx.drawImage(bmp, 0, y);
    y += bmp.height;
  }

  const outBlob = await canvas.convertToBlob({ type: "image/png" });
  return await blobToDataURL(outBlob);
}

async function captureSectionFull(tabId, locateFn) {
  const slices = await captureSectionSlices(tabId, locateFn);
  return await stitchSlices(slices);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function extractGameId(url) {
  // ESPN URLs often contain ".../gameId/401850949" (your example)
  const m = url.match(/gameId\/(\d+)/i);
  return m ? m[1] : null;
}

//SELECT KEY EVENTS FROM COMENTARY SECTION
function selectKeyEvents() {
  const buttons = Array.from(document.querySelectorAll("button, a"));

  const keyBtn = buttons.find(
    el => el.innerText?.trim() === "Key Events"
  );

  if (!keyBtn) {
    console.warn("Key Events button not found");
    return;
  }

  keyBtn.click();
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
    await sleep(800);
    await chrome.scripting.executeScript({
      target: { tabId },
      func: selectKeyEvents
    });
    await sleep(500);
    const commShot = await captureSectionFull(tabId, locatePageLayoutMain);
    await downloadDataUrl(commShot, `espn_${gameId}_commentary_${stamp}.png`);

    // 2) Stats
    await loadUrlInTab(tabId, stats);
    await waitForTabComplete(tabId);
    await sleep(800);
    const statsShot = await captureSectionFull(tabId, locatePageLayoutMain);
    await downloadDataUrl(statsShot, `espn_${gameId}_stats_${stamp}.png`);

    sendResponse({ ok: true });
  })().catch((e) => {
    console.error(e);
    sendResponse({ ok: false, error: e?.message || String(e) });
  });

  // Keep message channel open for async response
  return true;
});

