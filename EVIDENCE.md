# Capability Evidence — 0.5.0

Verified on 2026-10-04. This records mechanisms and measured outcomes, not task-success parity with commercial computer-use systems. Interface references are listed in [CAPABILITY-MATRIX.md](references/CAPABILITY-MATRIX.md).

## Validation environment and results

Windows, Node 22.19, project pnpm 12.6, Rust/cargo 1.98.1 and Python 3.13.7. Integration checks used the real Harness development checkout at commit `639ed01539` (release 0.2.0-rc.2 merge), not the running installed GUI host. A missing declared Harness `semver` dependency initially prevented CLI boot; frozen-lockfile installation repaired that test environment, after which the isolated profile check passed.

| Check | Result | What it proves |
| --- | --- | --- |
| `pnpm run verify` | 55 JavaScript tests, all passed; all JS syntax checked | Coordinate mapping, input/configuration bounds, provider contracts, semantic evidence isolation and real DSH ToolRuntime approval/attachment behavior |
| `python test/linux-reader-contracts.py` | 5 tests passed | Actual Python helper syntax and pure bounded reading/identity/password contracts; no AT-SPI bus runtime proof |
| Rust fmt/check/test/release build | Passed; 3 Rust tests | Native sequence prevalidation/duration/duplicate-input contracts and successful Windows release build |
| `pnpm run verify:profile` | Passed | A temporary real Loader profile mounted provider, all **18** tool schemas and workflow prompt; observation allow and control deny worked; temporary home removed |
| `node test/win32-expansion-smoke.mjs` | 8 checks passed | WPF UIA document/selection/value/range/multiple-selection/invoke and stale identity |
| `node test/win32-msaa-smoke.mjs` | 5 checks passed | Real WinForms MSAA tree/read/value-write/default action and PID rejection |
| `node test/win32-native-expansion-smoke.mjs` | 10 checks passed | The staged release exe exercised PrintWindow, fixed child messages, window resize, input/release/foreground failure and minimized discovery/recovery |

The staged native exe SHA-256 is `9a86acbb39edde4d36972c913fb5b5dd594e50a8e944386016e63bdd8b10b789`. The release manifest records its version and per-source/Cargo hashes. `prepack` repeats JS verification and checks those bytes against the current sources.

## Windows capability evidence

| Capability | Implementation and observed result | Reproduction |
| --- | --- | --- |
| Model-visible image attachment | PNG is stored through the real DSH attachment service, then read back; returned SHA-256 follows persisted normalized bytes. The tool rejects routes without declared image input. | `pnpm run verify` uses real ToolRuntime and LocalAttachmentStore. Successful live vision-model consumption remains pending: a prior route request ended upstream with 503. |
| Coordinate input | Fresh agent-scoped screenshot ID maps image pixels through actual source bounds, rejects out-of-image positions and safely clamps in-range fractional edge pixels. | JS mapping/evidence tests; earlier multi-display/region/crop/scale native capture probes. |
| Independent semantic path | Focused application or Windows window-root snapshots need no screenshot or image route. Optional image binding retains exact screenshot ID/hash; different fresh images are rejected. Read returns bounded native content without consuming evidence. | Text-only tool-loop tests and real UIA/MSAA fixtures. |
| UIA text/value/range/selection | WPF document text and selected `alpha beta` matched; ValuePattern write/read matched; slider RangeValue became 73; list selection count changed 1→2→1; button invoke changed status. Replaced expected name was rejected. | `win32-expansion-smoke.mjs`, 8 checks. Earlier owned WPF focus/set-value/toggle/invoke smoke also passed. |
| Separate legacy MSAA | AccessibleObjectFromWindow/AccessibleChildren drive a separate tree. Legacy editor initial/read-after-write values matched; default action changed status; wrong process identity was rejected. | `win32-msaa-smoke.mjs`, 5 checks. No claim that every MSAA action preserves foreground. |
| Sequence input and release | Actual Ctrl+A selected owned edit text, Unicode injection replaced it, and trailing held Control/mouse input was released at normal sequence end. F9 activated the fixture's cover; the next step stopped on lost foreground and Control was released. | `win32-native-expansion-smoke.mjs`; Rust validation tests plus JS duration/path/modifier contracts. Forced process termination is outside this release guarantee. |
| PrintWindow | A blue target under a fully occluding magenta TopMost window produced target RGB 100/149/237, with foreground unchanged. A minimized target returned an explicit error. | Native expansion smoke uses a fresh temporary deployment of the staged release exe. |
| Child HWND messages | A non-focusable Panel received fixed mouse messages without foreground change. Button handling activated its application and returned `foregroundChanged:true`. Wrong child PID was rejected. | Native expansion smoke. Delivery is distinct from business result; the fixture's resulting status was read separately. |
| Window management | Resize changed actual bounds without activation. After minimize, a **new** list returned `minimized:true`; focus using that fresh record restored the target and verified foreground. | Native expansion smoke. Close remains a request, not proof of closure. |
| Narrator | C# status compiled/called successfully and reported not running in Windows session 1. Fixed Standard bindings, Insert/CapsLock selection, stopped-reader no-input, cross-session rejection, single-use window evidence and approval rules passed. | Narrator/ToolRuntime contract tests. No Narrator process was started for voice/cursor testing. |
| Control failure evidence | A provider that records a partial input then throws consumes the original window ID; a subsequent key action cannot reuse it. | Real ToolRuntime integration test. |
| Approval/composition | Local deny is repeated by the final guard, ordinary asks cannot be silently bypassed, and default ask inherits authoritative Full access. Bundle installs host provider plus tools and workflow; it requires no preset. | Real ToolRuntime tests and temporary Loader profile probe. |

Native smoke tests own their WPF/WinForms processes and temporary scripts and clean them afterward. Production Windows code invokes no PowerShell: capture/input/window work uses the source-available Rust helper; UIA/MSAA/Narrator use optional edge-js C# bridges compiled in-process.

During reruns, a fixture's foreground activation needed time to settle, and another Harness window changed desktop focus during a slow UIA read. The native smoke now checks foreground immediately after message delivery and waits for the owned cover's actual state before later assertions. Final staged-exe run passed all 10 checks. This is an interactive shared desktop, not an isolated benchmark machine.

## Limits and pending native evidence

- UIA grid reads and special Scroll/Window/Transform patterns are implemented but have not each received a dedicated native fixture assertion. Bounds prevent unlimited tree work; custom-rendered or virtualized controls may expose no useful semantics.
- UIA TextRange.Select changed foreground in the WPF smoke. Semantic operations and child message handlers can affect focus according to application behavior; background operation is not a blanket guarantee.
- MSAA/child HWND paths cannot distinguish every same-property replacement generation. Read/action identity checks reduce stale targeting but do not create provider identity that the API lacks.
- PrintWindow depends on application rendering and integrity. Low-integrity development exe versus Medium target gave Win32 error 5; identical bytes in a new Medium temporary deployment worked. No automatic elevation, label repair or relocation is performed. GPU/protected targets may fail or yield blank images.
- Normal/handled-failure sequence cleanup is tested; crashes/forced managed cancellation can skip Rust destructors. In-process C# COM calls cannot be forcibly preempted by the subprocess deadline. See [SECURITY.md](SECURITY.md).
- Narrator commands assume Microsoft Standard layout. Actual configured layout is unknown; virtual cursor and speech are not observed. Input delivery does not establish that the reader spoke or moved its cursor.
- macOS AX and Linux AT-SPI have provider contracts, and Linux pure reader boundaries have Python tests. Their native desktops, permissions, accessibility buses and application action results remain untested. macOS capture origin versus Quartz coordinates on monitors left/above the primary remains pending.
- Extended Windows input is not silently emulated on other systems: unsupported sequence/hold/repeat/path/modifier/window-binding options reject explicitly. Explicit UIA/MSAA requests on macOS/Linux reject too.
- No task corpus, completion rate, recovery rate, action-count comparison or performance baseline was run. This release supports multiple paradigms; it has no SOTA-equivalence claim.

## Reproduce

```powershell
pnpm run verify
python test/linux-reader-contracts.py
pnpm run verify:profile
pnpm run smoke:windows
pnpm run smoke:linux
pnpm run smoke:macos
```

Set `DSH_HARNESS_ROOT` to an actual Harness checkout for integration tests. Other-platform smoke commands skip on Windows; a skip is not a pass on that platform. A future task benchmark should freeze application/environment versions and report completion, false actions, median actions/screenshots, recovery attempts and elapsed time against named baselines on the same corpus.
