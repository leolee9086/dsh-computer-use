# Upstream References and Adaptation Record

## Rubick

- Upstream: `https://github.com/rubickCenter/rubick`
- Self-maintained fork: `https://github.com/leolee9086/rubick`
- Audited source revision: `d2f3f347af9a1104fd92d19c78b849c710dc275f`
- License: MIT

Rubick's platform split and image handoff were reviewed. Its Windows capture path launches a bundled `ScreenCapture.exe` and reads the result from the Electron clipboard; its macOS path uses `screencapture -i -r -c`; it does not provide Linux capture. This project adapts the useful design rule, one provider per platform, but deliberately replaces clipboard handoff with direct PNG bytes and omits the opaque executable.

## Midscene

- Upstream: `https://github.com/web-infra-dev/midscene`
- Self-maintained fork: `https://github.com/leolee9086/midscene`
- License: MIT
- Audited fork revision: `18c5d9e5d51cd663d2c8a328503f901a54452154`
- Audited component: `packages/computer`

Midscene supplies the stronger cross-platform reference: a single device abstraction, multi-display support, native pointer/keyboard primitives, screenshot capture, and platform-aware scrolling. This project adapts its public behavior rather than importing its AI agent, npm package, or native dependency graph. In particular, its Linux capture-to-temporary-file recovery is implemented with a private `mkdtemp` directory and cleanup, then bounded by this provider's configured image limits.

## Other Baselines

- `nut.js` / `@nut-tree-fork/nut-js`: Apache-2.0 cross-platform native input reference. It is not a direct dependency because this project must retain a reviewable local implementation and avoid an unaudited native supply chain.
- FlaUI (MIT), pywinauto (BSD-3-Clause), and platform accessibility APIs: semantic-control reference for the Windows UI Automation tree and future macOS AX / Linux AT-SPI providers.
- Quicker: workflow and interaction reference only. Its code is not incorporated.

All newly written source in this project is MIT-licensed. No upstream source file or native binary is copied verbatim.
