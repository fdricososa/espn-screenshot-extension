function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

async function settleScroll(tabId) {
  await execInTab(tabId, async () => {
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => setTimeout(r, 80));
    return window.scrollY;
  });
}

function extractGameId(url) {
  const m = url.match(/gameId\/(\d+)/i);
  return m ? m[1] : null;
}

function buildUrls(gameId) {
  return {
    commentary: `https://www.espn.com/soccer/commentary/_/gameId/${gameId}`,
    stats: `https://www.espn.com/soccer/matchstats/_/gameId/${gameId}`,
    lineups: `https://www.espn.com/soccer/lineups/_/gameId/${gameId}`
  };
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

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
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

function enterCaptureModeHideSticky() {
  const STYLE_ID = "__espn_hide_sticky__";
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    /* Hide ESPN sticky match header */
    .Gamestrip__StickyContainer, .Site__Header {
      display: none !important;
      position: static !important;
      top: auto !important;
      transform: none !important;
      height: 0 !important;
      margin: 0 !important;
      padding: 0 !important;
    }
  `;
  document.head.appendChild(style);
}

function exitCaptureModeHideSticky() {
  document.getElementById("__espn_hide_sticky__")?.remove();
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

//GET MULTIPLE VIEWPORTS OF CONTAINERS
async function captureSectionSlices(tabId, locateFn, opts = {}) {
  const {
    settleMsAfterLocate = 250,
    settleMsAfterScroll = 450,
    maxSlices = 30,
    minIntervalBetweenCapturesMs = 650,
  } = opts;

  await execInTab(tabId, enterCaptureModeHideSticky);

  const info = await execInTab(tabId, locateFn);
  if (!info) throw new Error("Section not found (locator returned null).");
  if (typeof info.pageTop !== "number" || typeof info.height !== "number") {
    throw new Error("Locator must return { pageTop, height, viewportH }");
  }

  const startY = Math.max(0, Math.floor(info.pageTop));
  const totalH = Math.max(1, Math.floor(info.height));
  const viewportH = Math.max(1, Math.floor(info.viewportH || 1));
  const overlap = 80;
  const step = Math.max(1, viewportH - overlap);

  await sleep(settleMsAfterLocate);

  const slicesNeeded = Math.min(maxSlices, Math.ceil(totalH / viewportH));
  const tab = await chrome.tabs.get(tabId);

  const slices = [];
  let dy = 0;
  let lastCaptureAt = 0;
  let lastY = null;

  try {
    for (let i = 0; i < slicesNeeded; i++) {
      const y = startY + dy;

      // scroll window
      await execInTab(tabId, (yy) => window.scrollTo(0, yy), [y]);
      await sleep(settleMsAfterScroll);
      await settleScroll(tabId);

      // throttle (avoid quota)
      const now = Date.now();
      const waitMs = Math.max(
        0,
        minIntervalBetweenCapturesMs - (now - lastCaptureAt)
      );
      if (waitMs) await sleep(waitMs);

      // record REAL scrollY at capture time (the "truth" for overlap-free stitching)
      const actualY = await execInTab(tabId, () => window.scrollY);
      if (lastY !== null && Math.abs(actualY - lastY) < 1) break; // guard: avoid repeating same viewport forever
      lastY = actualY;

      // capture visible viewport
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: "png",
      });
      lastCaptureAt = Date.now();

      slices.push({ dataUrl, y: actualY });

      dy += step;
      if (dy >= totalH) break;
    }
  } finally {
    await execInTab(tabId, exitCaptureModeHideSticky);
  }
  return { slices, startY, totalH, viewportH };
}

//STITCH SLICES INTO ONE PNG
async function stitchSlices(payload) {
const { slices, startY, totalH, viewportH } = payload || {};
  if (!slices || slices.length === 0) throw new Error("No slices to stitch");

  // Decode to bitmaps
  const bitmaps = [];
  for (const s of slices) {
    const blob = await (await fetch(s.dataUrl)).blob();
    bitmaps.push(await createImageBitmap(blob));
  }

  // CSS px -> image px scale (captureVisibleTab returns device pixels)
  const scale = bitmaps[0].height / viewportH;
  const width = bitmaps[0].width;
  const outH = Math.max(1, Math.round(totalH * scale));

  const canvas = new OffscreenCanvas(width, outH);
  const ctx = canvas.getContext("2d");

  let prevBottom = 0;
  for (let i = 0; i < bitmaps.length; i++) {
    const bmp = bitmaps[i];
    const sliceY = slices[i].y;

    // Where this viewport starts inside the section (in image px)
    let destY = Math.round((sliceY - startY) * scale);

    // Crop anything above section top
    let cropTop = 0;
    if (destY < 0) {
      cropTop = -destY;
      destY = 0;
    }

    // Remove overlap with previous slice
    if (destY < prevBottom) {
      cropTop += (prevBottom - destY);
      destY = prevBottom;
    }

    if (destY >= outH) break;
    const remaining = outH - destY;
    const available = bmp.height - cropTop;
    const drawH = Math.min(remaining, available);
    if (drawH <= 0) continue;

    ctx.drawImage(bmp, 0, cropTop, width, drawH, 0, destY, width, drawH);
    prevBottom = destY + drawH;
  }

  const outBlob = await canvas.convertToBlob({ type: "image/png" });
  return await blobToDataURL(outBlob);
}

async function captureSectionFull(tabId, locateFn) {
  const payload = await captureSectionSlices(tabId, locateFn);
  return await stitchSlices(payload);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.type !== "CAPTURE_MATCH") return;

    const { tabId, url } = msg;
    const gameId = extractGameId(url);
    if (!gameId) {
      sendResponse({ ok: false, error: "No gameId found in current URL." });
      return;
    }

    const { commentary, stats, lineups } = buildUrls(gameId);
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

    // 3) Lineups
    await loadUrlInTab(tabId, lineups);
    await waitForTabComplete(tabId);
    await sleep(800);
    const lineShot = await captureSectionFull(tabId, locatePageLayoutMain);
    await downloadDataUrl(lineShot, `espn_${gameId}_lineups_${stamp}.png`);

    sendResponse({ ok: true });
  })().catch((e) => {
    console.error(e);
    sendResponse({ ok: false, error: e?.message || String(e) });
  });

  // Keep message channel open for async response
  return true;
});

