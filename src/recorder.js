/**
 * Media Grabber - recorder (side panel)
 *
 * Captures Tab audio, Microphone, or Tab + Mic mixed. Records to WebM
 * (MediaRecorder) or WAV (raw PCM encoded in-house). Tab audio is monitored to
 * the speakers; the mic is not (avoids echo). Features a live waveform,
 * pause/resume, and preview-before-save.
 */

const params = new URLSearchParams(location.search);
let targetTabId = params.get("tabId") ? Number(params.get("tabId")) : null;

// In side-panel mode no tabId is passed, so track the active tab of this window.
// Cached synchronously so the Start click can call getMediaStreamId in-gesture.
if (targetTabId == null) {
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, ([tab]) => {
    if (tab) targetTabId = tab.id;
  });
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    targetTabId = tabId;
  });
}

const els = {
  sources: document.querySelectorAll('input[name="source"]'),
  micRow: document.getElementById("micRow"),
  micDevice: document.getElementById("micDevice"),
  grantMic: document.getElementById("grantMic"),
  format: document.getElementById("format"),
  wave: document.getElementById("wave"),
  timer: document.getElementById("timer"),
  start: document.getElementById("start"),
  pause: document.getElementById("pause"),
  stop: document.getElementById("stop"),
  status: document.getElementById("status"),
  preview: document.getElementById("preview"),
  player: document.getElementById("player"),
  save: document.getElementById("save"),
  discard: document.getElementById("discard"),
};

const waveCtx = els.wave.getContext("2d");

// Session state
let ctx = null;
let mediaRecorder = null;
let webmChunks = [];
let processor = null;
let pcmLeft = [];
let pcmRight = [];
let wavRecording = false;
let wavPaused = false;
let analyser = null;
let vizRAF = 0;
let timerId = 0;
let startedAt = 0;
let pausedAccum = 0;
let pauseStart = 0;
let activeStreams = [];
let resultBlob = null;
let resultUrl = null;

const selectedSource = () => [...els.sources].find((r) => r.checked).value;

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle("error", isError);
}

// --- Microphone permission --------------------------------------------------

async function micPermissionState() {
  try {
    return (await navigator.permissions.query({ name: "microphone" })).state;
  } catch {
    return "prompt";
  }
}

els.grantMic.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/request-mic.html") });
});

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
  } catch {
    /* ignore */
  }
}

async function updateMicRow() {
  const needsMic = selectedSource() !== "tab";
  els.micRow.hidden = !needsMic;
  if (!needsMic) {
    els.grantMic.hidden = true;
    setStatus("");
    return;
  }
  const state = await micPermissionState();
  els.grantMic.hidden = state === "granted";
  setStatus(state === "granted" ? "" : 'Microphone needs permission — click "Grant microphone access".');
  listMics();
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

function getMicStream(deviceId) {
  return navigator.mediaDevices.getUserMedia({
    audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    video: false,
  });
}

async function buildGraph(source) {
  ctx = new AudioContext();
  await ctx.resume();
  const mixNode = ctx.createGain();

  if (source === "tab" || source === "tabmic") {
    const tabStream = await getTabStream(targetTabId);
    activeStreams.push(tabStream);
    const tabSrc = ctx.createMediaStreamSource(tabStream);
    tabSrc.connect(mixNode);
    tabSrc.connect(ctx.destination); // monitor: keep tab audio audible
  }

  if (source === "mic" || source === "tabmic") {
    const micStream = await getMicStream(els.micDevice.value);
    activeStreams.push(micStream);
    ctx.createMediaStreamSource(micStream).connect(mixNode); // no monitor -> no echo
    listMics();
  }

  analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  mixNode.connect(analyser);
  return mixNode;
}

// --- Recording --------------------------------------------------------------

async function start() {
  setStatus("");
  resetResult();
  const source = selectedSource();
  const format = els.format.value;

  // Mic permission gate.
  if (source !== "tab" && (await micPermissionState()) !== "granted") {
    els.grantMic.hidden = false;
    setStatus('Microphone is blocked. Click "Grant microphone access", allow it, then try again.', true);
    return;
  }

  try {
    const mixNode = await buildGraph(source);
    if (format === "wav") startWav(mixNode);
    else startWebm(mixNode);

    startedAt = Date.now();
    pausedAccum = 0;
    pauseStart = 0;
    startTimer();
    startViz();
    els.start.disabled = true;
    els.pause.disabled = false;
    els.pause.textContent = "Pause";
    els.stop.disabled = false;
    lockInputs(true);
    setStatus(`Recording ${labelFor(source)}...`);
  } catch (e) {
    cleanup();
    const hint =
      e.name === "NotAllowedError"
        ? ' Click "Grant microphone access" and allow it.'
        : "";
    setStatus(`Could not start: ${e.message}.${hint}`, true);
    if (e.name === "NotAllowedError") els.grantMic.hidden = false;
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
  wavPaused = false;
  const zeroGain = ctx.createGain();
  zeroGain.gain.value = 0;
  processor = ctx.createScriptProcessor(4096, 2, 2);
  processor.onaudioprocess = (e) => {
    if (!wavRecording || wavPaused) return;
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

function togglePause() {
  if (pauseStart) {
    // resume
    pausedAccum += Date.now() - pauseStart;
    pauseStart = 0;
    wavPaused = false;
    if (mediaRecorder && mediaRecorder.state === "paused") mediaRecorder.resume();
    els.pause.textContent = "Pause";
    setStatus(`Recording ${labelFor(selectedSource())}...`);
  } else {
    // pause
    pauseStart = Date.now();
    wavPaused = true;
    if (mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.pause();
    els.pause.textContent = "Resume";
    setStatus("Paused");
  }
}

function stop() {
  els.stop.disabled = true;
  els.pause.disabled = true;
  stopTimer();
  stopViz();
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
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
  els.pause.textContent = "Pause";
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

// --- Waveform & timer -------------------------------------------------------

function sizeCanvas() {
  els.wave.width = els.wave.clientWidth || 380;
}

function startViz() {
  sizeCanvas();
  const data = new Uint8Array(analyser.fftSize);
  const grad = waveCtx.createLinearGradient(0, 0, els.wave.width, 0);
  grad.addColorStop(0, "#4f46e5");
  grad.addColorStop(1, "#a855f7");

  const draw = () => {
    const w = els.wave.width;
    const h = els.wave.height;
    analyser.getByteTimeDomainData(data);
    waveCtx.clearRect(0, 0, w, h);
    waveCtx.lineWidth = 2;
    waveCtx.strokeStyle = grad;
    waveCtx.beginPath();
    const slice = w / data.length;
    let x = 0;
    for (let i = 0; i < data.length; i++) {
      const y = (data[i] / 128) * (h / 2);
      i === 0 ? waveCtx.moveTo(x, y) : waveCtx.lineTo(x, y);
      x += slice;
    }
    waveCtx.stroke();
    vizRAF = requestAnimationFrame(draw);
  };
  draw();
}

function stopViz() {
  cancelAnimationFrame(vizRAF);
  waveCtx.clearRect(0, 0, els.wave.width, els.wave.height);
}

function startTimer() {
  const tick = () => {
    const now = pauseStart || Date.now();
    const s = Math.floor((now - startedAt - pausedAccum) / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    els.timer.textContent = `${mm}:${ss}`;
  };
  tick();
  timerId = setInterval(tick, 250);
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
els.pause.addEventListener("click", togglePause);
els.stop.addEventListener("click", stop);
window.addEventListener("resize", () => {
  if (!vizRAF) sizeCanvas();
});

updateMicRow();
sizeCanvas();
