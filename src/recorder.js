/**
 * Media Grabber - recorder window
 *
 * A self-contained recording page (opened in its own window) that captures:
 *   - Tab audio (via tabCapture.getMediaStreamId + getUserMedia)
 *   - Microphone (getUserMedia)
 *   - Tab + Microphone mixed
 * Records to WebM (MediaRecorder) or WAV (raw PCM, encoded in-house). Tab audio
 * is routed to the speakers so it stays audible; the microphone is not, to avoid
 * an echo. Shows a live level meter and a preview before saving.
 */

const params = new URLSearchParams(location.search);
const targetTabId = params.get("tabId") ? Number(params.get("tabId")) : null;

const els = {
  sources: document.querySelectorAll('input[name="source"]'),
  micRow: document.getElementById("micRow"),
  micDevice: document.getElementById("micDevice"),
  format: document.getElementById("format"),
  meterFill: document.getElementById("meterFill"),
  timer: document.getElementById("timer"),
  start: document.getElementById("start"),
  stop: document.getElementById("stop"),
  status: document.getElementById("status"),
  preview: document.getElementById("preview"),
  player: document.getElementById("player"),
  save: document.getElementById("save"),
  discard: document.getElementById("discard"),
};

// Recording session state
let ctx = null;
let mediaRecorder = null;
let webmChunks = [];
let processor = null;
let pcmLeft = [];
let pcmRight = [];
let wavRecording = false;
let analyser = null;
let meterRAF = 0;
let timerId = 0;
let startedAt = 0;
let activeStreams = [];
let resultBlob = null;
let resultUrl = null;

function selectedSource() {
  return [...els.sources].find((r) => r.checked).value;
}

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle("error", isError);
}

// --- Device list ------------------------------------------------------------

async function listMics() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((d) => d.kind === "audioinput");
    els.micDevice.innerHTML = "";
    if (!mics.length || !mics[0].label) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "Default microphone";
      els.micDevice.appendChild(opt);
      return;
    }
    mics.forEach((m, i) => {
      const opt = document.createElement("option");
      opt.value = m.deviceId;
      opt.textContent = m.label || `Microphone ${i + 1}`;
      els.micDevice.appendChild(opt);
    });
  } catch (e) {
    /* ignore */
  }
}

function updateMicRow() {
  const needsMic = selectedSource() !== "tab";
  els.micRow.hidden = !needsMic;
}

els.sources.forEach((r) => r.addEventListener("change", updateMicRow));

// --- Stream acquisition -----------------------------------------------------

function getTabStreamId(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      if (chrome.runtime.lastError || !id) {
        reject(new Error(chrome.runtime.lastError?.message || "no tab stream"));
      } else {
        resolve(id);
      }
    });
  });
}

async function getTabStream(tabId) {
  const streamId = await getTabStreamId(tabId);
  return navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
    video: false,
  });
}

async function getMicStream(deviceId) {
  return navigator.mediaDevices.getUserMedia({
    audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    video: false,
  });
}

/**
 * Build the audio graph for the chosen source.
 * Returns { mixNode } where mixNode carries the recording mix. Tab audio is
 * connected separately to the speakers for monitoring.
 */
async function buildGraph(source) {
  ctx = new AudioContext();
  await ctx.resume();
  const mixNode = ctx.createGain();

  if (source === "tab" || source === "tabmic") {
    const tabStream = await getTabStream(targetTabId);
    activeStreams.push(tabStream);
    const tabSrc = ctx.createMediaStreamSource(tabStream);
    tabSrc.connect(mixNode); // into the recording mix
    tabSrc.connect(ctx.destination); // monitor: keep tab audio audible
  }

  if (source === "mic" || source === "tabmic") {
    const micStream = await getMicStream(els.micDevice.value);
    activeStreams.push(micStream);
    ctx.createMediaStreamSource(micStream).connect(mixNode); // mic into mix only (no monitor -> no echo)
    listMics(); // labels are available now that permission was granted
  }

  // Level meter taps the mix.
  analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  mixNode.connect(analyser);

  return mixNode;
}

// --- Recording --------------------------------------------------------------

async function start() {
  setStatus("");
  resetResult();
  const source = selectedSource();
  const format = els.format.value;

  try {
    const mixNode = await buildGraph(source);

    if (format === "wav") {
      startWav(mixNode);
    } else {
      startWebm(mixNode);
    }

    startedAt = Date.now();
    startTimer();
    startMeter();
    els.start.disabled = true;
    els.stop.disabled = false;
    lockInputs(true);
    setStatus(`Recording ${labelFor(source)}...`);
  } catch (e) {
    cleanup();
    setStatus(`Could not start: ${e.message}`, true);
  }
}

function startWebm(mixNode) {
  const dest = ctx.createMediaStreamDestination();
  mixNode.connect(dest);
  const mimeType = ["audio/webm;codecs=opus", "audio/webm"].find((t) =>
    MediaRecorder.isTypeSupported(t)
  );
  webmChunks = [];
  mediaRecorder = new MediaRecorder(dest.stream, { mimeType, audioBitsPerSecond: 256000 });
  mediaRecorder.ondataavailable = (e) => e.data.size > 0 && webmChunks.push(e.data);
  mediaRecorder.onstop = () => finalize(new Blob(webmChunks, { type: mediaRecorder.mimeType }));
  mediaRecorder.start();
}

function startWav(mixNode) {
  pcmLeft = [];
  pcmRight = [];
  wavRecording = true;
  const zeroGain = ctx.createGain();
  zeroGain.gain.value = 0; // drives the processor without adding mic audio to the speakers
  processor = ctx.createScriptProcessor(4096, 2, 2);
  processor.onaudioprocess = (e) => {
    if (!wavRecording) return;
    const input = e.inputBuffer;
    const l = input.getChannelData(0);
    const r = input.numberOfChannels > 1 ? input.getChannelData(1) : l;
    pcmLeft.push(new Float32Array(l));
    pcmRight.push(new Float32Array(r));
  };
  mixNode.connect(processor);
  processor.connect(zeroGain);
  zeroGain.connect(ctx.destination);
}

function stop() {
  els.stop.disabled = true;
  stopTimer();
  stopMeter();
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop(); // -> finalize via onstop
  } else if (wavRecording) {
    wavRecording = false;
    finalize(encodeWav(pcmLeft, pcmRight, ctx.sampleRate));
  }
}

function finalize(blob) {
  resultBlob = blob;
  resultUrl = URL.createObjectURL(blob);
  els.player.src = resultUrl;
  els.preview.hidden = false;
  setStatus(`Done — ${(blob.size / 1024 / 1024).toFixed(2)} MB. Preview, then Save.`);
  cleanup();
  els.start.disabled = false;
  lockInputs(false);
}

// --- Save / discard ---------------------------------------------------------

els.save.addEventListener("click", () => {
  if (!resultBlob) return;
  const ext = resultBlob.type.includes("wav") ? "wav" : "webm";
  const a = document.createElement("a");
  a.href = resultUrl;
  a.download = `media-grabber-recording-${Date.now()}.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
});

els.discard.addEventListener("click", resetResult);

function resetResult() {
  els.preview.hidden = true;
  els.player.removeAttribute("src");
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = null;
  resultBlob = null;
}

// --- Meter & timer ----------------------------------------------------------

function startMeter() {
  const data = new Uint8Array(analyser.frequencyBinCount);
  const draw = () => {
    analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
    els.meterFill.style.width = `${Math.min(100, (peak / 128) * 140)}%`;
    meterRAF = requestAnimationFrame(draw);
  };
  draw();
}
function stopMeter() {
  cancelAnimationFrame(meterRAF);
  els.meterFill.style.width = "0%";
}

function startTimer() {
  const tick = () => {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    els.timer.textContent = `${mm}:${ss}`;
  };
  tick();
  timerId = setInterval(tick, 500);
}
function stopTimer() {
  clearInterval(timerId);
}

// --- Helpers ----------------------------------------------------------------

function lockInputs(locked) {
  els.sources.forEach((r) => (r.disabled = locked));
  els.format.disabled = locked;
  els.micDevice.disabled = locked;
}

function labelFor(source) {
  return { tab: "tab audio", mic: "microphone", tabmic: "tab + microphone" }[source];
}

function cleanup() {
  if (processor) {
    processor.disconnect();
    processor.onaudioprocess = null;
    processor = null;
  }
  activeStreams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  activeStreams = [];
  if (ctx) ctx.close();
  ctx = null;
  mediaRecorder = null;
  analyser = null;
}

function encodeWav(leftChunks, rightChunks, sampleRate) {
  let frames = 0;
  for (const c of leftChunks) frames += c.length;
  const numChannels = 2;
  const blockAlign = numChannels * 2;
  const dataSize = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  let li = 0, ri = 0, lo = 0, ro = 0;
  for (let f = 0; f < frames; f++) {
    while (li < leftChunks.length && lo >= leftChunks[li].length) { li++; lo = 0; }
    while (ri < rightChunks.length && ro >= rightChunks[ri].length) { ri++; ro = 0; }
    const l = Math.max(-1, Math.min(1, leftChunks[li][lo++]));
    const r = Math.max(-1, Math.min(1, rightChunks[ri][ro++]));
    view.setInt16(offset, l < 0 ? l * 0x8000 : l * 0x7fff, true);
    offset += 2;
    view.setInt16(offset, r < 0 ? r * 0x8000 : r * 0x7fff, true);
    offset += 2;
  }
  return new Blob([view], { type: "audio/wav" });
}

els.start.addEventListener("click", start);
els.stop.addEventListener("click", stop);

updateMicRow();
listMics();
