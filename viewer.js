const img = document.getElementById("img");

function getToken() {
  const u = new URL(location.href);
  return u.searchParams.get("token");
}

async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return await res.blob();
}

(async () => {
  const copyBtn = document.getElementById("copyBtn");
  const downloadBtn = document.getElementById("downloadBtn");

  const token = getToken();
  if (!token) {
    console.log("Missing token.");
    return;
  }

  const stored = await chrome.storage.session.get(token);
  const payload = stored?.[token];
  if (!payload?.dataUrl) {
    console.log("Image not found (session expired).");
    return;
  }

  const { dataUrl, title } = payload;

  img.src = dataUrl;

  copyBtn.addEventListener("click", async () => {
    try {
      const blob = await dataUrlToBlob(dataUrl);

      await navigator.clipboard.write([
        new ClipboardItem({ [blob.type]: blob })
      ]);

      showToast("Image copied to clipboard! ✅");
    } catch (e) {
      console.error(e);
      showToast("Copy failed. Try Download.");
    }
  });

  downloadBtn.addEventListener("click", async () => {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = title || "espn_capture.png";
    showToast("Downloaded ✅");
    a.click();
  });

  contextMenu.appendChild(createMenuItem("Copy image", async () => {
    try {
      const blob = await dataUrlToBlob(img.src);
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      showToast("Image copied to clipboard! ✅");
    } catch (e) {
      showToast("Error while copying image.", true);
    }
  }));

  contextMenu.appendChild(createMenuItem("Save image as...", async () => {
    try {
      chrome.runtime.sendMessage({
        type: "SAVE_AS",
        dataUrl: img.src,
        filename: title || "espn_capture.png"
      });
    } catch (e) {
      showToast("Error saving image.", true);
    }
  }));

  document.body.appendChild(contextMenu);
  })();

img.addEventListener("click", () => {
  if (img.classList.contains("zoom-in")) {
    img.classList.replace("zoom-in", "zoom-out");
    img.style.width = `${img.naturalWidth}px`;
    img.style.height = `${img.naturalHeight}px`;
    img.style.maxWidth = "none";
  } else {
    img.classList.replace("zoom-out", "zoom-in");
    fitPreviewToViewport();
  }
});

function fitPreviewToViewport() {
  const header = document.querySelector(".header");

  if (!img.naturalWidth || !img.naturalHeight) return;

  const headerH = header?.getBoundingClientRect().height || 0;
  const margin = 24; // padding extra
  const maxH = Math.max(100, window.innerHeight - headerH - margin);

  const scale = Math.min(1, maxH / img.naturalHeight);

  img.style.width = `${Math.floor(img.naturalWidth * scale)}px`;
  img.style.height = `${Math.floor(img.naturalHeight * scale)}px`;
  img.style.objectFit = "contain";
}

img.onload = () => {
  fitPreviewToViewport();
};

window.addEventListener("resize", () => fitPreviewToViewport());

document.addEventListener("wheel", (e) => {
  if (e.ctrlKey) {
    e.preventDefault();
  }
}, { passive: false });

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && ["+", "-", "=", "0"].includes(e.key)) {
    e.preventDefault();
  }
});

function showToast(msg, isError = false) {
  const toast = document.createElement("div");
  toast.textContent = msg;
  toast.style.cssText = `
    position: fixed;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%);
    background: ${isError ? "#c0392b" : "#2ecc71"};
    color: white;
    padding: 10px 20px;
    border-radius: 8px;
    font-size: 14px;
    box-shadow: 0 4px 12px rgba(0,0,0,.2);
    opacity: 1;
    transition: opacity 0.5s ease;
    z-index: 99999;
    pointer-events: none;
  `;
  document.body.appendChild(toast);
  setTimeout(() => toast.style.opacity = "0", 1800);
  setTimeout(() => toast.remove(), 3000);
}

const contextMenu = document.createElement("div");
contextMenu.style.cssText = `
  position: fixed;
  background: white;
  border: 1px solid #ccc;
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0,0,0,.15);
  padding: 4px 0;
  z-index: 9999;
  display: none;
  min-width: 160px;
  font-family: Arial, sans-serif;
  font-size: 14px;
`;

function createMenuItem(label, onClick) {
  const item = document.createElement("div");
  item.textContent = label;
  item.style.cssText = `padding: 8px 16px; cursor: pointer;`;
  item.addEventListener("mouseenter", () => item.style.background = "#f0f0f0");
  item.addEventListener("mouseleave", () => item.style.background = "white");
  item.addEventListener("click", () => {
    contextMenu.style.display = "none";
    onClick();
  });
  return item;
}

const previewWrap = document.querySelector(".preview-wrap");
previewWrap.addEventListener("contextmenu", (e) => {
  e.preventDefault();

  contextMenu.style.display = "block";

  const menuW = contextMenu.offsetWidth;
  const menuH = contextMenu.offsetHeight;
  const x = e.clientX + menuW > window.innerWidth  ? e.clientX - menuW : e.clientX;
  const y = e.clientY + menuH > window.innerHeight ? e.clientY - menuH : e.clientY;

  contextMenu.style.left = `${x}px`;
  contextMenu.style.top  = `${y}px`;
});

document.addEventListener("click", () => contextMenu.style.display = "none");
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") contextMenu.style.display = "none";
});
