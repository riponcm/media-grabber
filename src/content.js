/**
 * Media Grabber - content script
 *
 * Scans the page for <audio>, <video> and <source> elements and reports their
 * URLs to the background worker. Re-scans when the DOM changes or media starts
 * playing, since many players inject media late.
 */

const URL_PATTERN = /^(https?:|blob:)/;
const RESCAN_DELAY_MS = 800;

/** Collect media element URLs and report them to the background worker. */
function collectMedia() {
  const items = [];

  for (const el of document.querySelectorAll("audio, video, source")) {
    // currentSrc is what is actually playing; fall back to declared src.
    for (const url of [el.currentSrc, el.src, el.getAttribute("src")]) {
      if (url && URL_PATTERN.test(url)) {
        items.push({ url, tag: el.tagName.toLowerCase() });
      }
    }
  }

  if (items.length) {
    chrome.runtime.sendMessage({ type: "dom-media", items }).catch(() => {});
  }
}

// Initial scan.
collectMedia();

// Re-scan on DOM mutations (throttled).
let rescanScheduled = false;
const observer = new MutationObserver(() => {
  if (rescanScheduled) return;
  rescanScheduled = true;
  setTimeout(() => {
    rescanScheduled = false;
    collectMedia();
  }, RESCAN_DELAY_MS);
});

observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["src"],
});

// Re-scan when any media element begins playback.
document.addEventListener("play", collectMedia, true);
