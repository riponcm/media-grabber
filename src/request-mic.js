/**
 * Media Grabber - microphone permission helper.
 *
 * getUserMedia prompts are unreliable inside a side panel, so we request the
 * permission here in a normal tab. Permission is stored per-origin, and all
 * extension pages share the same origin, so the recorder side panel can then
 * use the microphone without prompting.
 */

const stateEl = document.getElementById("state");
const grantBtn = document.getElementById("grant");

async function request() {
  stateEl.textContent = "";
  stateEl.className = "state";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop()); // we only needed the permission
    stateEl.textContent = "Microphone access granted. You can close this tab and return to the recorder.";
    stateEl.classList.add("ok");
    grantBtn.disabled = true;
  } catch (e) {
    stateEl.textContent = `Access not granted (${e.name}). If it was blocked, enable the microphone for this extension in the address-bar site settings, then try again.`;
    stateEl.classList.add("err");
  }
}

grantBtn.addEventListener("click", request);

// Try once automatically on load (the page is a tab, so the prompt shows reliably).
request();
