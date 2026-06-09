# Privacy Policy — Media Grabber

_Last updated: 2026_

Media Grabber is a Chrome extension that detects and downloads audio/video on the page you are
viewing and lets you record tab or microphone audio to a file.

## The short version
**Media Grabber does not collect, store, transmit, or sell any personal data.** Everything runs
locally in your browser. There are no accounts, no analytics, no tracking, and no external servers.

## What the extension accesses, and why
All processing happens on your device. The extension never sends your data anywhere.

- **Page network/response info** (`webRequest`): read locally to detect media (audio/video) on the
  current page. Read-only — no requests are blocked, modified, or logged externally.
- **Page content** (`scripting`, host access): the current page is scanned for `<audio>`/`<video>`
  elements when you open the popup or press refresh.
- **Downloads** (`downloads`): used only to save a file you explicitly choose to download.
- **Microphone / tab audio** (`tabCapture`, `getUserMedia`): used only while **you** start a
  recording. Audio is captured into a file on your device and is never uploaded.
- **Local storage** (`storage`): stores small preferences (e.g., your recording format) and
  transient state. Stays on your device.

## Data sharing
None. No data is collected, so none is shared, sold, or sent to third parties.

## Remote code
The extension contains no remote code. All logic ships inside the package.

## Permissions summary
Permissions exist solely to provide the detection, download, and recording features described
above, on the page you are actively using. They are not used for tracking or profiling.

## Changes
Any changes to this policy will be published in this file in the project repository.

## Contact
Questions or issues: please open an issue at
https://github.com/riponcm/media-grabber/issues
