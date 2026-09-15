# Upstream References and Adaptation Record

## Rubick

- Upstream: `https://github.com/rubickCenter/rubick`
- Self-maintained fork: `https://github.com/leolee9086/rubick`
- Audited source revision: `d2f3f347af9a1104fd92d19c78b849c710dc275f`
- License: MIT

Rubick's platform split and image handoff were reviewed. Its Windows capture path launches a bundled `ScreenCapture.exe` and reads the result from the Electron clipboard; its macOS path uses `screencapture -i -r -c`; it does not provide Linux capture. This project adapts the useful design rule, one provider per platform, but deliberately replaces clipboard handoff with direct PNG bytes and omits the opaque executable.

## Quicker

- Official product and workflow documentation: `https://getquicker.net/` and `https://getquicker.net/KC/Help/Doc/uiautomation`.
- Quicker's documented UIAutomation and FlaUI actions informed the separation between window discovery, semantic control lookup, and action-time re-identification. Its workflow model also informed this project's explicit observe/act/observe protocol and the agent-scoped workflow prompt.
- Quicker is not an open-source dependency and no Quicker code, binary, protocol, or account service is included here.

## Midscene

- Upstream: `https://github.com/web-infra-dev/midscene`
- Self-maintained fork: `https://github.com/leolee9086/midscene`
- License: MIT
- Audited fork revision: `18c5d9e5d51cd663d2c8a328503f901a54452154`
- Audited component: `packages/computer`

Midscene supplies the stronger cross-platform reference: a single device abstraction, multi-display support, native pointer/keyboard primitives, screenshot capture, and platform-aware scrolling. This project adapts its public behavior rather than importing its AI agent, npm package, or native dependency graph. In particular, its Linux capture-to-temporary-file recovery is implemented with a private `mkdtemp` directory and cleanup, then bounded by this provider's configured image limits.

## FastAX

- Upstream: `https://github.com/stephancasas/fast-ax`
- License: MIT
- FastAX's direct AXUIElement/JXA approach was reviewed as the macOS semantic reference. This project uses a bundled, bounded JXA helper with PID/path re-resolution and name/role/bounds identity checks; it does not import FastAX or its source.

## Other Baselines

- `nut.js` / `@nut-tree-fork/nut-js`: Apache-2.0 cross-platform native input reference. It is not a direct dependency because this project must retain a reviewable local implementation and avoid an unaudited native supply chain.
- FlaUI: `https://github.com/FlaUI/FlaUI` (MIT); pywinauto: `https://github.com/pywinauto/pywinauto` (BSD-3-Clause); GNOME pyatspi2: `https://github.com/GNOME/pyatspi2` (LGPL-2.1-or-later); Apple's AXUIElement reference: `https://developer.apple.com/documentation/applicationservices/axuielement`. These inform the native semantic adapters; their source is not imported.
- Quicker remains a workflow and interaction reference only. Its code is not incorporated.

All newly written source in this project is MIT-licensed. No upstream source file or native binary is copied verbatim.
