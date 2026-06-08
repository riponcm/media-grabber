/**
 * Media Grabber - offscreen document
 *
 * Runs MediaRecorder to capture a tab's audio output (Manifest V3 service
 * workers have no DOM, so recording must happen here). The captured tab audio
 * is also routed to the speakers so the user keeps hearing it while recording.
 */

let recorder = null;
let chunks = [];
let audioContext = null;

/** Pick the best supported audio container/codec. */
function pickMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
  ];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || "";
}

async function startRecording(streamId) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });

  // Keep the audio audible to the user while it is being captured.
  audioContext = new AudioContext();
  audioContext.createMediaStreamSource(stream).connect(audioContext.destination);

  const mimeType = pickMimeType();
  chunks = [];
  recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 256000 });

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  recorder.onstop = async () => {
    const blob = new Blob(chunks, { type: recorder.mimeType });
    const dataUrl = await blobToDataUrl(blob);
    stream.getTracks().forEach((t) => t.stop());
    if (audioContext) audioContext.close();
    chrome.runtime.sendMessage({
      type: "recording-complete",
      dataUrl,
      mimeType: recorder.mimeType,
    });
    recorder = null;
  };

  recorder.start();
}

function stopRecording() {
  if (recorder && recorder.state !== "inactive") recorder.stop();
}

function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "offscreen-start") {
    startRecording(message.streamId).catch((e) =>
      chrome.runtime.sendMessage({ type: "recording-error", error: String(e) })
    );
  } else if (message.type === "offscreen-stop") {
    stopRecording();
  }
});
