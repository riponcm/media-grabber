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

function fileNameFromUrl(url) {
  try {
    const { pathname } = new URL(url);
    let name = decodeURIComponent(pathname.split("/").pop() || "").split("?")[0];
    if (!name || !name.includes(".")) name = `media-${Date.now()}`;
    return name;
  } catch {
    return `media-${Date.now()}`;
  }
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
  const name = fileNameFromUrl(item.url);
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
// Tab audio recording
// ---------------------------------------------------------------------------

const recordBtn = document.getElementById("record");
const recordLabel = document.getElementById("recordLabel");
const recordTime = document.getElementById("recordTime");
let timerInterval = null;

function formatElapsed(ms) {
  const total = Math.floor(ms / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function setRecordingUI(active, startedAt) {
  recordBtn.classList.toggle("recording", active);
  recordLabel.textContent = active ? "Stop recording" : "Record tab audio";
  recordTime.hidden = !active;

  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  if (active) {
    const tick = () => (recordTime.textContent = formatElapsed(Date.now() - startedAt));
    tick();
    timerInterval = setInterval(tick, 500);
  }
}

// Locally cached so the click handler can act synchronously (a user gesture is
// required by chrome.tabCapture.getMediaStreamId and must not be lost to an
// async round-trip before the call).
let isRecording = false;

function refreshRecordingState() {
  chrome.runtime.sendMessage({ type: "recording-status" }, (state) => {
    isRecording = Boolean(state?.active);
    setRecordingUI(isRecording, state?.startedAt || 0);
  });
}

recordBtn.addEventListener("click", () => {
  if (isRecording) {
    chrome.runtime.sendMessage({ type: "stop-recording" }, () => {
      isRecording = false;
      setRecordingUI(false);
    });
    return;
  }
  if (activeTabId == null) return;

  // Call getMediaStreamId directly in the gesture — no async hop before this.
  chrome.tabCapture.getMediaStreamId({ targetTabId: activeTabId }, (streamId) => {
    if (chrome.runtime.lastError || !streamId) {
      alert(
        `Could not start capture: ${chrome.runtime.lastError?.message || "no stream"}\n\n` +
          "Make sure this tab is the active tab and is playing audio."
      );
      return;
    }
    chrome.runtime.sendMessage(
      { type: "start-recording", streamId, tabId: activeTabId },
      () => {
        isRecording = true;
        setRecordingUI(true, Date.now());
      }
    );
  });
});

load();
refreshRecordingState();
