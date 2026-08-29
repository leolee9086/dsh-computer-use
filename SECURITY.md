# Security and Operating Boundary

## Authority

The host provider can observe and control the active local desktop. It never opens a remote-control listener, accepts a remote desktop endpoint, or starts an automation action without a model tool call. Every system command is launched through DSH's managed subprocess service with a configured deadline, output cap, process-tree cancellation, and private temporary-file cleanup.

## Image Handling

A screenshot is captured directly as PNG bytes. The provider does not use the system clipboard, Rubick's `ScreenCapture.exe`, an Electron runtime, or an opaque native binary. Before publishing an image attachment, `computer_screenshot` verifies that the current model route explicitly supports image input.

The returned screenshot ID is scoped to the calling agent, retained in memory only, bounded per agent, and expires after `maxObservationAgeMs`. Pointer coordinates are rejected outside the exact attachment dimensions and translated through the saved native desktop rectangle. A later model step cannot reuse an image ID from another agent or a stale screen state.

## Input Handling

All pointer and keyboard calls are exclusive tool calls. The intended operation loop is observe, act once, then observe again. Window focus is treated as desktop control. Windows input uses a generated PowerShell helper that sets DPI awareness before coordinate-sensitive APIs, sends Unicode with `SendInput`, and always releases the mouse button in the helper's `finally` path.

`observeApproval` and `controlApproval` each support `ask`, `allow`, and `deny`. The package default is `ask`. The installed `computer-use` preset currently sets both values to `allow` because it is an explicit delegated-control preset and this DSH session has approval prompts disabled. Change either value to `deny` to remove that operation class from the preset, or to `ask` when the host has an interactive approval flow.

## Platform Coverage

Windows is the full local provider: direct PNG capture, multi-display physical coordinates, pointer/keyboard, top-level window control, and a bounded UI Automation tree. macOS supports direct capture and keyboard automation; pointer actions require the optional `cliclick` command plus Accessibility permission. Linux supports capture through `grim`, `gnome-screenshot`, or ImageMagick; pointer/keyboard/window commands require `xdotool` and therefore an X11-compatible session. Unsupported operations fail with a capability error rather than silently falling back.

## Sensitive Screen Content

A desktop screenshot can contain credentials, personal data, and other information visible on screen. The image becomes a DSH attachment and is supplied to the selected model route. Treat the selected model provider and its retention policy as part of the desktop-control trust decision.
