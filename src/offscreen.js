/**
 * Media Grabber - offscreen document
 *
 * Captures a tab's audio output (Manifest V3 service workers have no DOM, so
 * recording must happen here). Two modes:
 *   - "webm": MediaRecorder -> WebM/Opus (small, lossy).
 *   - "wav":  Web Audio PCM capture -> WAV (lossless, no dependency).
 * In both modes the captured audio is routed to the speakers so the user keeps
 * hearing it while recording.
 */

let mode = null;            // "webm" | "wav"
let recording = false;
let audioContext = null;
let sourceStream = null;

// webm mode
let recorder = null;
let chunks = [];

// wav mode
let processor = null;
let pcmLeft = [];
let pcmRight = [];

function pickMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || "";
}

async function startRecording(streamId, format) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
    video: false,
  });
  sourceStream = stream;
  audioContext = new AudioContext();
  await audioContext.resume();
  const source = audioContext.createMediaStreamSource(stream);

  if (format === "wav") {
    mode = "wav";
    pcmLeft = [];
    pcmRight = [];
    processor = audioContext.createScriptProcessor(4096, 2, 2);
    processor.onaudioprocess = (e) => {
      if (!recording) return;
      const input = e.inputBuffer;
      const l = input.getChannelData(0);
      const r = input.numberOfChannels > 1 ? input.getChannelData(1) : l;
      pcmLeft.push(new Float32Array(l));
      pcmRight.push(new Float32Array(r));
    };
    source.connect(processor);
    processor.connect(audioContext.destination); // drives the processor and keeps audio audible
  } else {
    mode = "webm";
    source.connect(audioContext.destination); // keep audio audible
    chunks = [];
    recorder = new MediaRecorder(stream, { mimeType: pickMimeType(), audioBitsPerSecond: 256000 });
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = () => finalizeWebm();
    recorder.start();
  }

  recording = true;
}

function stopRecording() {
  if (!recording) return;
  recording = false;
  if (mode === "webm") {
    if (recorder && recorder.state !== "inactive") recorder.stop(); // fires onstop -> finalizeWebm
  } else {
    finalizeWav();
  }
}

async function finalizeWebm() {
  const blob = new Blob(chunks, { type: recorder.mimeType });
  const dataUrl = await blobToDataUrl(blob);
  cleanup();
  chrome.runtime.sendMessage({ type: "recording-complete", dataUrl, mimeType: recorder.mimeType });
}

async function finalizeWav() {
  const blob = encodeWav(pcmLeft, pcmRight, audioContext.sampleRate);
  const dataUrl = await blobToDataUrl(blob);
  cleanup();
  chrome.runtime.sendMessage({ type: "recording-complete", dataUrl, mimeType: "audio/wav" });
}

function cleanup() {
  if (processor) {
    processor.disconnect();
    processor.onaudioprocess = null;
    processor = null;
  }
  if (sourceStream) sourceStream.getTracks().forEach((t) => t.stop());
  if (audioContext) audioContext.close();
  audioContext = null;
  recorder = null;
  chunks = [];
  pcmLeft = [];
  pcmRight = [];
  mode = null;
}

/** Encode accumulated stereo Float32 PCM chunks into a 16-bit WAV blob. */
function encodeWav(leftChunks, rightChunks, sampleRate) {
  let frames = 0;
  for (const c of leftChunks) frames += c.length;

  const numChannels = 2;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
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
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  let li = 0;
  let ri = 0;
  let liOff = 0;
  let riOff = 0;
  for (let f = 0; f < frames; f++) {
    while (li < leftChunks.length && liOff >= leftChunks[li].length) { li++; liOff = 0; }
    while (ri < rightChunks.length && riOff >= rightChunks[ri].length) { ri++; riOff = 0; }
    const l = Math.max(-1, Math.min(1, leftChunks[li][liOff++]));
    const r = Math.max(-1, Math.min(1, rightChunks[ri][riOff++]));
    view.setInt16(offset, l < 0 ? l * 0x8000 : l * 0x7fff, true);
    offset += 2;
    view.setInt16(offset, r < 0 ? r * 0x8000 : r * 0x7fff, true);
    offset += 2;
  }
  return new Blob([view], { type: "audio/wav" });
}

function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.target !== "offscreen") return;
  if (message.type === "offscreen-start") {
    startRecording(message.streamId, message.format).catch((e) =>
      chrome.runtime.sendMessage({ type: "recording-error", error: String(e) })
    );
  } else if (message.type === "offscreen-stop") {
    stopRecording();
  }
});
