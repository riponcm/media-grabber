/**
 * Media Grabber - background service worker (Manifest V3)
 *
 * Responsibilities:
 *   - Observe network responses and collect media URLs (audio, video, streams).
 *   - Receive DOM-detected media reported by the content script.
 *   - Maintain a per-tab list of unique media items.
 *   - Answer popup queries and keep the toolbar badge in sync.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Directly downloadable media file extensions. */
const FILE_EXTENSIONS = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|weba|mp4|m4v|webm|mov|mkv|avi|flv|3gp)(\?|#|$)/i;

/** Streaming playlist extensions (require FFmpeg to reassemble). */
const STREAM_EXTENSIONS = /\.(m3u8|mpd)(\?|#|$)/i;

/** Ignore "file" responses smaller than this (likely stream segments, not full media). */
const MIN_FILE_BYTES = 50 * 1024;

const BADGE_COLOR = "#4f46e5";

// ---------------------------------------------------------------------------
// State: tabId -> Map<url, MediaItem>
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} MediaItem
 * @property {string} url
 * @property {"file"|"stream"|"blob"} kind
 * @property {string} type    Content-Type or element tag.
 * @property {?number} size   Bytes, if known.
 * @property {"network"|"dom"} source
 */

const mediaByTab = new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Determine the media kind for a URL + content type, or null if not media. */
function classify(url, contentType = "") {
  const ct = contentType.toLowerCase();
  if (STREAM_EXTENSIONS.test(url) || ct.includes("mpegurl") || ct.includes("dash+xml")) {
    return "stream";
  }
  if (FILE_EXTENSIONS.test(url) || ct.startsWith("audio/") || ct.startsWith("video/")) {
    return "file";
  }
  return null;
}

/** Add a media item to a tab's collection (deduplicated by URL). */
function addMedia(tabId, item) {
  if (tabId == null || tabId < 0) return;

  let collection = mediaByTab.get(tabId);
  if (!collection) {
    collection = new Map();
    mediaByTab.set(tabId, collection);
  }
  if (!collection.has(item.url)) {
    collection.set(item.url, item);
    updateBadge(tabId);
  }
}

/** Reflect the current media count on the toolbar badge. */
function updateBadge(tabId) {
  const count = mediaByTab.get(tabId)?.size ?? 0;
  chrome.action.setBadgeText({ tabId, text: count ? String(count) : "" });
  chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR });
}

/** Read a header value by (case-insensitive) name. */
function header(headers, name) {
  const lower = name.toLowerCase();
  return headers?.find((h) => h.name.toLowerCase() === lower)?.value ?? null;
}

// ---------------------------------------------------------------------------
// Network observation
// ---------------------------------------------------------------------------

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const contentType = header(details.responseHeaders, "content-type") ?? "";
    const contentLength = parseInt(header(details.responseHeaders, "content-length"), 10) || null;

    const kind = classify(details.url, contentType);
    if (!kind) return;

    // Skip tiny "file" responses that are really streaming segments.
    if (kind === "file" && contentLength != null && contentLength < MIN_FILE_BYTES) return;

    addMedia(details.tabId, {
      url: details.url,
      kind,
      type: contentType || "unknown",
      size: contentLength,
      source: "network",
    });
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// ---------------------------------------------------------------------------
// Messaging (content script + popup)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case "dom-media": {
      if (!sender.tab) break;
      for (const item of message.items) {
        const kind =
          classify(item.url) ?? (item.url.startsWith("blob:") ? "blob" : "file");
        addMedia(sender.tab.id, {
          url: item.url,
          kind,
          type: item.tag ?? "element",
          size: null,
          source: "dom",
        });
      }
      sendResponse({ ok: true });
      break;
    }

    case "get-media": {
      const collection = mediaByTab.get(message.tabId);
      sendResponse({ items: collection ? [...collection.values()] : [] });
      break;
    }

    case "clear-media": {
      mediaByTab.delete(message.tabId);
      updateBadge(message.tabId);
      sendResponse({ ok: true });
      break;
    }
  }
  return true; // keep the message channel open for async responses
});

// ---------------------------------------------------------------------------
// Tab lifecycle
// ---------------------------------------------------------------------------

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // Reset on a new top-level navigation.
  if (changeInfo.status === "loading" && changeInfo.url) {
    mediaByTab.delete(tabId);
    updateBadge(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  mediaByTab.delete(tabId);
});

// ---------------------------------------------------------------------------
// Tab audio recording (for MediaSource / blob streams that cannot be saved)
// ---------------------------------------------------------------------------

// State is kept in session storage so it survives service-worker restarts
// (MV3 terminates the worker after ~30s idle, which would otherwise lose it).
const REC_KEY = "recordingState";
const IDLE_STATE = { active: false, tabId: null, startedAt: 0 };

async function getRecordingState() {
  const { [REC_KEY]: state } = await chrome.storage.session.get(REC_KEY);
  return state || IDLE_STATE;
}

async function setRecordingState(state) {
  await chrome.storage.session.set({ [REC_KEY]: state });
}

async function ensureOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: "src/offscreen.html",
    reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
    justification: "Record the active tab's audio output to a file.",
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case "start-recording": {
      (async () => {
        const state = await getRecordingState();
        if (state.active) {
          sendResponse({ ok: false, reason: "already-active" });
          return;
        }
        await ensureOffscreenDocument();
        chrome.runtime.sendMessage({
          target: "offscreen",
          type: "offscreen-start",
          streamId: message.streamId,
          format: message.format || "webm",
        });
        const startedAt = Date.now();
        await setRecordingState({ active: true, tabId: message.tabId, startedAt });
        chrome.action.setBadgeText({ tabId: message.tabId, text: "REC" });
        chrome.action.setBadgeBackgroundColor({ tabId: message.tabId, color: "#dc2626" });
        sendResponse({ ok: true, startedAt });
      })();
      return true;
    }

    case "stop-recording": {
      chrome.runtime.sendMessage({ target: "offscreen", type: "offscreen-stop" });
      sendResponse({ ok: true });
      return true;
    }

    case "recording-status": {
      getRecordingState().then((state) => sendResponse(state));
      return true;
    }

    case "recording-complete": {
      const mt = message.mimeType || "";
      const ext = mt.includes("wav") ? "wav" : mt.includes("ogg") ? "ogg" : "webm";
      chrome.downloads.download({
        url: message.dataUrl,
        filename: `media-grabber-recording-${Date.now()}.${ext}`,
      });
      finishRecording();
      return false;
    }

    case "recording-error": {
      console.error("Recording error:", message.error);
      finishRecording();
      return false;
    }
  }
});

async function finishRecording() {
  const state = await getRecordingState();
  if (state.tabId != null) updateBadge(state.tabId);
  await setRecordingState(IDLE_STATE);
  if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
}
