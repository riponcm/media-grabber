/**
 * Media Grabber - popup UI logic
 *
 * Requests the active tab's collected media from the background worker and
 * renders a list with per-item actions (download files, copy FFmpeg for streams).
 */

const listEl = document.getElementById("list");
const emptyEl = document.getElementById("empty");
const countEl = document.getElementById("count");

let activeTabId = null;

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

// Map a content-type to a file extension, used when the URL has no usable one.
const MIME_EXT = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/x-matroska": "mkv",
  "video/quicktime": "mov",
  "video/x-msvideo": "avi",
  "video/x-flv": "flv",
  "video/3gpp": "3gp",
  "video/mpeg": "mpeg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "weba",
  "audio/flac": "flac",
  "application/vnd.apple.mpegurl": "m3u8",
  "application/x-mpegurl": "m3u8",
  "application/dash+xml": "mpd",
};

function extFromMime(type) {
  if (!type) return "";
  return MIME_EXT[type.split(";")[0].trim().toLowerCase()] || "";
}

/** Build a download filename, deriving the extension from the content-type if the URL lacks one. */
function fileNameFromUrl(url, mimeType) {
  let name = "";
  try {
    const { pathname } = new URL(url);
    name = decodeURIComponent(pathname.split("/").pop() || "").split("?")[0];
  } catch {
    /* fall through */
  }
  if (!name) name = `media-${Date.now()}`;
  // Append an extension when the name has none (e.g. /download/abc123 served as video/mp4).
  if (!/\.[a-z0-9]{2,5}$/i.test(name)) {
    const ext = extFromMime(mimeType);
    if (ext) name += `.${ext}`;
  }
  return name;
}

function humanSize(bytes) {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

function ffmpegCommand(url) {
  const base = fileNameFromUrl(url).replace(/\.(m3u8|mpd)$/i, "") || "output";
  return `ffmpeg -i "${url}" -c copy "${base}.mp4"`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render(items) {
  listEl.innerHTML = "";
  emptyEl.style.display = items.length ? "none" : "block";
  countEl.textContent = `${items.length} item${items.length === 1 ? "" : "s"}`;

  for (const item of items) {
    listEl.appendChild(renderItem(item));
  }
}

function renderItem(item) {
  const name = fileNameFromUrl(item.url, item.type);
  const li = document.createElement("li");

  const row = document.createElement("div");
  row.className = "row";

  const badge = document.createElement("span");
  badge.className = `badge ${item.kind}`;
  badge.textContent = item.kind;
  row.appendChild(badge);

  const nameCell = document.createElement("span");
  nameCell.className = "name-cell";
  nameCell.textContent = name;
  nameCell.title = item.url;
  row.appendChild(nameCell);

  row.appendChild(item.kind === "stream" ? streamButton(item) : downloadButton(item, name));
  li.appendChild(row);

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = [item.type, humanSize(item.size), item.source].filter(Boolean).join("  ·  ");
  li.appendChild(meta);

  if (item.kind === "stream") {
    const command = document.createElement("div");
    command.className = "command";
    command.textContent = ffmpegCommand(item.url);
    li.appendChild(command);
  }

  return li;
}

function downloadButton(item, name) {
  const btn = document.createElement("button");
  btn.className = "btn";
  btn.textContent = "Download";
  btn.addEventListener("click", () => downloadItem(item, name));
  return btn;
}

function streamButton(item) {
  const btn = document.createElement("button");
  btn.className = "btn secondary";
  btn.textContent = "Copy FFmpeg";
  btn.addEventListener("click", () => {
    navigator.clipboard.writeText(ffmpegCommand(item.url));
    btn.textContent = "Copied";
    setTimeout(() => (btn.textContent = "Copy FFmpeg"), 1200);
  });
  return btn;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function downloadItem(item, name) {
  if (item.url.startsWith("blob:")) {
    downloadBlobViaPage(item.url, name);
    return;
  }
  chrome.downloads.download({ url: item.url, filename: name }, () => {
    if (chrome.runtime.lastError) {
      alert(`Download failed: ${chrome.runtime.lastError.message}`);
    }
  });
}

/** Blob URLs belong to the page context; fetch and save them from inside the tab. */
function downloadBlobViaPage(blobUrl, name) {
  chrome.scripting.executeScript(
    {
      target: { tabId: activeTabId },
      args: [blobUrl, name],
      func: async (url, fname) => {
        try {
          const blob = await (await fetch(url)).blob();
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = fname;
          document.body.appendChild(a);
          a.click();
          a.remove();
          return "ok";
        } catch (e) {
          return `fail:${e.message}`;
        }
      },
    },
    (results) => {
      const result = results?.[0]?.result;
      if (result && result.startsWith("fail")) {
        alert(
          "This is a streamed blob (likely MSE) and cannot be saved directly.\n" +
            "If a stream (.m3u8 / .mpd) entry also appears, use its FFmpeg command instead."
        );
      }
    }
  );
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

function load() {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab) return;
    activeTabId = tab.id;
    chrome.runtime.sendMessage({ type: "get-media", tabId: activeTabId }, (resp) => {
      render(resp?.items ?? []);
    });
  });
}

document.getElementById("refresh").addEventListener("click", () => {
  if (activeTabId == null) return load();
  // Force a fresh DOM scan, then reload the list.
  chrome.scripting.executeScript(
    { target: { tabId: activeTabId }, files: ["src/content.js"] },
    () => setTimeout(load, 400)
  );
});

document.getElementById("clear").addEventListener("click", () => {
  if (activeTabId == null) return;
  chrome.runtime.sendMessage({ type: "clear-media", tabId: activeTabId }, load);
});

// ---------------------------------------------------------------------------
// Recorder window
// ---------------------------------------------------------------------------

document.getElementById("record").addEventListener("click", () => {
  if (activeTabId == null) return;
  // Open the docked side panel (must be called within the user gesture).
  chrome.sidePanel.open({ tabId: activeTabId });
  window.close();
});

load();
