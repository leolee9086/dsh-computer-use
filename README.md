# dsh-computer-use

`dsh-computer-use` is an independent Cordis plugin suite that gives DeepSeek Harness a model-visible, audited desktop-computer capability without modifying the Harness source tree or any shipped agent preset.

The installable bundle publishes one `computer` service and activates the model-facing tool and workflow-prompt plugins from the same bundle patch. No agent preset is created or required.

## Bundle structure

One package, one bare-package loader row, dual faces — the same shape as `dsh-tool-websearch` and `dsh-tool-restart`:

- `exports["."]` → `src/index.js` — the bare-package row's host half; re-exports the host plugin (`provide('computer')`). Its loader row keeps the `dsh-computer-use-host` id so existing profile-layer config overrides stay valid.
- `exports["./tool"]` → `src/tool.js`, `exports["./prompt"]` → `src/prompt.js` — subpath rows, each with its own config block (the Loader replaces a row's whole `config`, so host and tool parameters stay independently overridable).
- `exports["./client"]` → `src/client.js` — the browser half (`dsh.client.platform: "web"`), scanned into `window.__DSH_BOOT__` through the same bare-package row. It renders the `computer_screenshot` tool card as a real image via the session-authorized `loadImage` loader supplied in the toolview owner props; `read_image` keeps the product's built-in image card and is not shadowed.

The browser half must keep its `__ModuleLoader__.load` id equal to the package name — the client-modules graph validates the registration id against the graph entry id.

## Capability Model

- Screenshot observations return a model-visible image attachment, a SHA-256 hash of its persisted bytes, and a short-lived screenshot ID.
- A capture may target the whole virtual desktop, one display (`display_id`), or a single region (`x`/`y`/`width`/`height` in virtual-desktop pixels, negative allowed), optionally magnified with `scale`. A region that leaves the virtual desktop is cropped to it, and the reported `source_bounds` always describes the area actually captured — which is what keeps coordinate actions correct for a partial capture.
- Coordinate operations must name that screenshot ID. The provider converts persisted image pixels back to physical desktop coordinates using the original capture bounds retained with the observation, then clamps an in-image fractional coordinate to that rectangle's final physical pixel.
- Native accessibility observations must name a fresh screenshot ID and persist that exact screenshot ID and SHA-256 hash in a short-lived semantic snapshot. The tree is rooted at the focused element's nearest native Window/Application and returns stable native element IDs, control metadata, bounds, focusability, and supported patterns. `computer_find` narrows it by name, role, or automation ID; `computer_element` accepts only the screenshot bound to that snapshot.
- Semantic actions support native invoke/focus/value/toggle/expand/collapse/select behavior and `scroll_into_view` for a discovered offscreen element. `scroll_into_view` is a standalone state-changing step: capture a new screenshot and semantic snapshot before any following action.
- Screenshot evidence is single-use for a consequential desktop action. Every successful coordinate or semantic action consumes all screenshot, semantic, and window-list records for that agent. Window focus requires a fresh agent-scoped `window_id` returned by `computer_windows:list` and also consumes all prior records. The next control action therefore requires a newly captured desktop state.
- Windows re-identifies an element at action time by its UIA runtime ID plus process and current identity attributes. It fails if the observed element was replaced or changed, rather than applying an action to a merely similar control. Model-visible snapshots remain bounded by `maxAccessibilityNodes`; re-identification uses a finite control-view traversal bounded by `maxAccessibilityActionCandidates`, so it does not materialize an entire process tree before applying the limit.
- Input actions are serialized and are exclusive tool calls. The next step should observe the screen again before taking another consequential action.
- Windows provides direct capture (whole desktop, one display, or an arbitrary region, via the bundled `native/dsh-screen.exe`), pointer/keyboard injection, visible non-minimized top-level window enumeration, a bounded UI Automation tree, semantic element lookup, and pattern-based UIA actions including scroll-into-view. Before focus it re-validates the listed HWND against its PID, title, and bounds, then verifies final foreground state and retries a failed normal foreground request through temporary input-queue attachment.
- macOS provides direct capture, keyboard automation, bounded System Events window enumeration/focus, an AX semantic adapter, and pointer actions through bundled JXA helpers. Only windows that expose a native window identity are listed. A listed window ID binds its PID, title, bounds, and native window ID; focus verifies exactly one current match before foregrounding its application, revalidates after foregrounding, then focuses it. Pointer and AX operations require macOS Accessibility permission; AX snapshot/action calls also require Automation permission. AX actions re-check PID, name, role, and observed bounds when available.
- Linux captures through system facilities and uses `xdotool` on X11-compatible sessions for pointer, keyboard, window enumeration, focus, and active-window reporting. It skips a window that disappears while querying its metadata, and focus re-validates the listed XID's PID, title, and bounds before activation. Its AT-SPI semantic adapter uses `python3`/`python` with `pyatspi` and an active AT-SPI bus; it lazily enumerates children within the configured node/candidate budget and rejects an action path deeper than its originating snapshot limit.
- When the installed `@yuxianglin/dsh-bridge-browser` host bundle is connected, the resulting agent receives its `browser_*` text/DOM tools alongside `computer_*`. The workflow prompt requires fresh evidence when crossing the browser/desktop boundary and prevents mixing browser indices, desktop coordinates, and native element IDs. The domains remain deliberately separate; there is no synthetic cross-domain locator.
- The provider does not use the system clipboard as an image transport, and does not depend on Rubick's opaque `ScreenCapture.exe`. Windows captures through its own bundled native helper (`native/dsh-screen.exe`, Rust + Win32 GDI, MIT): the capture path is open source, the protocol is documented in `native/README.md`, and PNGs are handed back through a temporary file rather than a stdout pipe or the clipboard.

## Install Into The Current Web Profile

From `D:\dev\deepseek-harness`:

```powershell
pnpm dsh plugin --profile web add D:\dev\dsh-computer-use
```

That installs the bundle into the profile and adds its `cordis.patch.yml` layer. The layer activates the host provider, model-facing tool consumer, and workflow prompt together; no preset edit is part of installation. The bundle stack is read when the Harness process starts, so restart the existing Harness through its normal restart control before starting a session; refreshing the browser page alone does not mount a newly installed bundle.

The bundle defaults `observeApproval` and `controlApproval` to `ask`. When the current agent's DSH permission preset resolves to `danger-full-access` (the `Full access` UI choice), those default asks inherit the preset's no-prompt approval policy and proceed automatically. An explicit `deny` in this plugin still wins. A profile patch may override either plugin row, but Loader layers replace each row's complete `config` value rather than deep-merging it. Restate the full tool config when overriding a row. `maxAccessibilityActionCandidates` defaults to `5000`; it is separate from the model-visible tree bound `maxAccessibilityNodes`.

## Development

```powershell
npm run verify
npm run verify:profile
npm run smoke:windows
npm run smoke:linux
npm run smoke:macos
```

The Windows display smoke is a read-only provider probe. `npm run verify:profile` creates a temporary DSH home, installs only this bundle into it, and boots a real Loader profile to check the provider, all model-facing schemas, and the workflow prompt without creating or mounting a preset. It resolves a sibling `../deepseek-harness` checkout by default; set `DSH_HARNESS_ROOT` to use another checkout. The semantic focus smoke starts a uniquely titled disposable WPF window, focuses its native Edit element through UI Automation, sets its own text, toggles its own checkbox, invokes its own button, and confirms each resulting status in a fresh UIA snapshot before it terminates only that child process and removes its temporary script.

Linux semantic prerequisites: `python3` or `python` with the `pyatspi` module and a running AT-SPI bus. macOS semantic prerequisites: Automation and Accessibility permissions for `osascript`; the bundled `src/macos-ax.js` helper is invoked with JXA. The platform adapters are contract-tested on Windows, while native runtime smoke must be run on each target operating system.

The project has no runtime npm dependency. It uses the live Cordis services supplied by the host profile, so it remains an independently versioned project while DSH remains the composition host.

## Security

Read [SECURITY.md](SECURITY.md) before enabling control actions. [EVIDENCE.md](EVIDENCE.md) records the verified mechanisms, reproducible checks, and the remaining gaps before any SOTA-style claim.

## Provenance

See [references/UPSTREAM.md](references/UPSTREAM.md). The project records the audited references and uses no third-party desktop-automation binary or direct npm driver dependency.
