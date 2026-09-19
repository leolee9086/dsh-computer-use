# Capability Evidence Matrix

This document records what the current project has actually verified. It is intentionally narrower than a benchmark claim: a working mechanism is not proof of parity with a commercial computer-use product or an open-source task benchmark.

## Verified Windows Capabilities

| Capability | Implementation evidence | Reproduction |
| --- | --- | --- |
| Model-visible desktop image | `computer_screenshot` stores direct PNG capture bytes as a DSH image attachment, reads the persisted normalized bytes back for verification, returns their SHA-256 hash, and rejects a route without declared image input. | `npm run verify` boots a temporary real Harness `ToolRuntime` and `LocalAttachmentStore`, executes the registered screenshot tool, checks its text-plus-image output, reads the durable attachment, and proves the returned hash follows persisted bytes. A successful live model-route screenshot remains pending because the prior route attempt ended with an upstream 503. |
| Pixel-to-desktop coordinate safety | Screenshot records retain source bounds; coordinate actions require a fresh agent-scoped screenshot ID and are mapped by `mapScreenshotPoint`, which clamps a valid fractional image coordinate to the source rectangle's final physical pixel. | `npm run verify` covers origin offsets, downscaling, out-of-image rejection, and fractional coordinates at the attachment edge. |
| Application semantic tree | Windows UI Automation snapshots climb from the focused element to its nearest native Window, then emit bounded control-view nodes with runtime IDs, process IDs, bounds, patterns, and focus state. | `node test/win32-smoke.mjs` exercised a real multi-display desktop and returned a Window-root tree. |
| Semantic element lookup | `computer_find` performs bounded name/role/automation-ID matching and hides disabled or offscreen nodes by default. | `npm run verify` covers exact/contains matching, automation IDs, offscreen filtering, and empty optional selector normalization. |
| Evidence-bound semantic action | A semantic snapshot is created only against one fresh screenshot and persists its ID plus SHA-256. `computer_element` rejects a different screenshot even when both observations are fresh. `computer_windows:list` creates short-lived agent-scoped window IDs; focus accepts only a listed ID and then consumes all observations for that agent. | `npm run verify` includes mismatched-screenshot rejection, single-use evidence tests, and rejection of unlisted or consumed window IDs. |
| Foreground-window recovery | Windows enumerates eligible visible non-minimized top-level HWNDs, binds each agent-scoped model `window_id` to the observed native PID/title/bounds record, rechecks that identity before focus, then requests foreground normally and temporarily joins only the helper, current foreground, and target input queues if foreground-lock rules reject it. It verifies both identity and foreground handle before returning success. | `npm run verify` statically verifies EnumWindows/identity payload construction; `npm run smoke:windows` enumerated live top-level windows and focused the disposable WPF window with its full observed record. |
| Tool-level semantic loop | The tool package binds screenshot, accessibility snapshot, lookup, and UIA action to one agent-scoped evidence record. Empty optional tool fields are normalized only when semantically empty; non-empty out-of-operation values still fail. Its final `tools.guard()` repeats a local `deny` after extensible pre-execution listeners. Default `ask` detects the current agent's authoritative `danger-full-access` permission preset and becomes allow; otherwise, a listener that short-circuits a local `ask` still triggers a tool-body approval request before the desktop provider. | `npm run verify` exercises assembled mismatched-evidence and single-use-action cases, then boots real `ToolRuntime` to verify denied, asked, and Full access operations after reordered pre-execution listeners. |
| Bundle browser and desktop composition | The host browser bridge registers text/DOM-oriented `browser_*` tools process-wide; this bundle patch inserts the desktop consumer and workflow prompt alongside the host provider. | A temporary real DSH profile installed only this bundle and booted all three rows; a Loader probe observed the Windows `computer` provider, all 11 `computer_*` schemas, and the workflow prompt. No preset was mounted. |
| Re-identification before action | Windows resolves a runtime ID again through a finite control-view traversal, compares current automation ID/name/class/role, and errors on mismatch. It does not fall back to coordinate control. Model-visible snapshots are bounded separately from a finite 5,000-node action traversal. | `node test/win32-semantic-focus-smoke.mjs` creates a disposable WPF window, re-focuses its UIA Edit element across separate bridge calls, then validates native `set_value`, `toggle`, and `invoke` actions through fresh status snapshots. `npm run verify` asserts the backend carries no PowerShell route at all (no script constant, no shell probe, no runtime C# compilation) — the search bound and identity re-check themselves are exercised by the smoke, not by matching source text. |
| Pattern actions | Invoke, focus, set value, toggle, expand, collapse, select, and scroll-into-view are exposed only when their UIA patterns are present. | Unit tests cover unsupported pattern rejection and offscreen `scroll_into_view` dispatch. |
| Cleanup boundary | Windows writes no script files at all: pointer, keyboard, window, and capture work runs in the bundled native helper, and UI Automation runs in-process through a C# bridge. The semantic action smoke removes its temporary WPF script and terminates only its own child process. | Inspect `src/windows.js`, `src/csharp.js`, and `test/win32-semantic-focus-smoke.mjs`. |

## Implemented, Pending Native Runtime Evidence

| Capability | Implementation status | Required proof |
| --- | --- | --- |
| macOS window, pointer, and AX semantics | `src/macos.js` uses built-in `osascript -l JavaScript` with System Events only for windows with a non-empty native window identity. Opaque IDs bind PID/title/bounds/native ID; focus verifies one current match before foregrounding the process, revalidates after foregrounding, and rejects absent or ambiguous identity. It calls the bundled `macos-ax.js` JXA helper for bounded frontmost-window AX snapshots and action-time PID/name/role/bounds checks. The bundled `macos-input.js` helper emits interpolated CoreGraphics pointer, drag, and scroll events. | Run window/list/focus, pointer, AX snapshot, and a disposable native-control action smoke on a macOS desktop with Automation and Accessibility permission. Validate screenshot-to-Quartz coordinates on a multi-monitor layout with a display left of or above the primary. |
| Linux X11 and AT-SPI semantics | `src/linux.js` records each visible XID's PID/title/bounds, skips windows that disappear during metadata lookup, re-validates the record before `windowactivate`, and verifies the active XID afterward. It calls bundled `linux-atspi.py` through `python3`/`python` plus `pyatspi` for lazily enumerated bounded snapshots and action-time process/path/identity checks; action paths are capped by the snapshot depth. | Run a real X11-compatible desktop smoke with a visible native control and AT-SPI bus; include an XID replacement/disappearance race and missing-`pyatspi` diagnostics. |

## Current Boundaries

- Windows is the high-capability backend with native runtime evidence. macOS AX and Linux AT-SPI semantic adapters are implemented and contract-tested but need native-runtime evidence on those operating systems.
- macOS composite-capture origin versus Quartz global pointer coordinates has not been verified on a layout with displays left of or above the primary; it remains an explicit native smoke requirement.
- Browser-specific DOM automation and the desktop semantic loop coexist in one agent when the browser bridge and this bundle are installed. Their identifiers remain intentionally domain-specific; the workflow prompt requires fresh evidence at each boundary.
- The snapshot is intentionally bounded by `maxAccessibilityNodes` and `maxAccessibilityDepth`; deeply virtualized or custom-rendered controls can be absent from UIA.
- UIA metadata differs by application. `focusable` is a useful hint, not a guarantee that a provider accepts `SetFocus`; native action errors remain explicit.
- No benchmark corpus, success-rate measurement, recovery-rate measurement, or baseline comparison has been run. The project must not be described as SOTA-equivalent until those measurements exist.

## Suggested Task Evaluation

Use a declared Windows task corpus with at least these categories:

1. Browser form navigation and safe text entry.
2. Native dialog discovery, selection, and confirmation.
3. Multi-window focus and context switching.
4. Offscreen list-item discovery followed by semantic scroll and re-observation.
5. Coordinate-only visual controls with changed screen-state recovery.
6. Failure recovery after an element becomes stale or a UIA pattern disappears.

For every task, record completion rate, median action count, screenshot count, semantic lookup count, recovery attempts, false actions, and elapsed time. Compare the same frozen task set and environment against named baselines before making a parity or SOTA claim.

## Commands

```powershell
npm run verify
npm run verify:profile
npm run smoke:windows
npm run smoke:linux
npm run smoke:macos
```

The semantic focus smoke opens a uniquely titled disposable WPF window, focuses its empty test Edit control, sets its own text, toggles its own checkbox, invokes its own button, and confirms each status in fresh UIA snapshots before it removes its own child process and temporary script. It does not operate on user documents.

The Linux and macOS commands self-skip on other operating systems; on their native host they fail loudly when the required capture, accessibility, or permission boundary is missing. Their native-runtime output should be appended to this matrix after running on each OS.
