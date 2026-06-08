# Contributing to Media Grabber

Thanks for your interest in improving Media Grabber. Contributions of all sizes are welcome,
from bug reports to new features.

## Ways to help

- Report bugs or request features through issues.
- Improve detection coverage for additional media types or players.
- Refine the popup UI and accessibility.
- Improve documentation.

## Development setup

No build step is required. The extension runs directly from source.

1. Clone the repository.
2. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**.
3. Select the project folder.
4. After editing files, click the reload icon on the extension card to apply changes.

## Code style

- Plain, dependency-free JavaScript (ES2020+).
- Keep modules focused: `background.js` for collection, `content.js` for the DOM,
  `popup.js` for the UI.
- Prefer small, well-named functions and short comments that explain intent.

## Pull requests

1. Create a feature branch.
2. Keep changes focused and described clearly.
3. Test against a few real pages before submitting.
4. Open the pull request with a short summary of what changed and why.

## Scope and ethics

Media Grabber is intended for media users are entitled to download. Please do not submit changes
that attempt to bypass DRM or otherwise defeat access controls.
