# Capability Evidence — 0.5.13

## Current validation — 2026-10-09

0.5.13 adds bounded Windows related-window discovery and locator flows across real menus, popups and external dialogs. The bundle retains 25 tools. Visible positive-area untitled top-level HWNDs are now listed with class, thread and actual owner-chain metadata. `computer_windows:related` and locator `window_query` stay pinned to the original HWND/PID/title. `owned` follows the actual owner chain and can cross process boundaries; `same_thread` and `same_process` express correlation only. Native HWND fields support review, while short-lived session window IDs authorize controls.

The actual Electron 44.0.0 / Node 24.18.1 / ABI149 acceptance uses a real Cordis Context, ToolRuntime, production WindowsComputer, managed semantic worker and the official subprocess service. The tested release build, staged 0.5.13 artifact and its temporary medium-integrity copies share executable SHA-256 `92bc9da4d250856ffa2f5054557938b7458f6ff5754f1423d7b07bfbe98a87db`. The final default joint entry passed both modules in sequence, recording the four-mode fixture results at 09:27:41Z and the actual Sound-property flow at 09:27:47Z on 2026-10-09, with both completion markers after cleanup. The fixtures use actual framework controls/providers, not fabricated related-window or semantic-query results.

| Task | Observed result |
| --- | --- |
| Win32 TrackPopupMenu | Untitled `#32768` root discovered with explicit thread correlation; actual MSAA default action produces exactly one WM_COMMAND and business action per open, across two rounds |
| Native menu lifecycle | Menu start/return and WM_ENTERMENULOOP/WM_EXITMENULOOP counters are exactly 1 then 2; foregroundAtTrack matches the observed main HWND |
| WinForms ToolStripDropDown | Two successful rounds with exact open/action counts; the initial empty-title thread query genuinely finds the dropdown and SysShadow, reports ambiguity and exposes candidates before exact observed-class refinement |
| WPF Primitives.Popup | A genuine independent untitled popup root and default AutomationPeers; Button/Text name ambiguity is resolved with the observed Button role and automation ID; two exact business actions |
| External dialog | Actual child process has a different PID and a native owner chain containing the original main HWND; two opens/actions complete and read back main-window business status |
| Forms/WPF root replacement | Disabled root closes after 250ms, then a new enabled root appears after 100ms; wait re-resolves a new semantic reference, and the third action yields opens/actions 3 with replacements 1 |
| Closing and stale references | Complete related-window absence after each close; old semantic references are refused and independently read business counts do not grow |
| Duplicate owned roots | Two same-title related roots report ambiguity with actual candidates; neither target receives an action |
| Partial directory | max_windows 1 reports incomplete scope and cannot satisfy absent; inspected HWND count includes non-matches |
| Cancellation/source change | In-flight wait cancellation is reported; original anchor rename is a source error, never successful absence or redirection |

A separate actual-application test starts a fresh system Sound window with `rundll32 shell32.dll,Control_RunDLL mmsys.cpl` through the official runner. It uniquely selects an actually observed device, confirms Properties is enabled, and uses the observed Properties(P) mnemonic through explicit Alt+P. Each of two rounds then acquires a fresh directory, waits for one actual owned `#32770` root, checks the owner chain/PID/new HWND, reads real property TabItems, invokes Cancel and confirms complete absence. A fresh locator reads back the original device name. The main Sound window also closes with Cancel; the flow uses no Apply/OK or settings write. Context, runner, loader and temporary-directory cleanup precede completion markers.

Provider and timing limits remain explicit. A prior actual Properties UIA Invoke blocked until its ten-second deadline; the terminated worker returned execution_state unknown with expired references. Its original failure is retained locally. That action was not replayed or relabeled completed: a new Sound instance used the explicit mnemonic flow. An earlier Win32 menu UIA Invoke completed at the provider level but produced zero WM_COMMAND/business actions; the accepted native-menu path explicitly selects MSAA accDoDefaultAction and does not establish UIA Invoke reliability. One earlier WPF Open locator timed out before dispatch; its cause remains undetermined, and the later successful full run does not erase it. Earlier console-related native failures are retained as diagnostics without assigning one cause to every failure.

Related-window scans have explicit node/time limits, exact title/class filters, coverage, stop reason and inspected count. Partial zero/one candidates cannot prove absence/uniqueness; multiple roots stop with ambiguity and publish actual candidates. Only an explicitly identified candidate-change `COMPUTER_LOCATOR_CHANGED/not_started` permits read-only reacquisition within the same deadline. Fixed-anchor identity errors, other source errors and cancellation stop the wait. `after.window_query` can discover a newly created root; explicit `after.window_id` without a query reads that listed window directly and clears inherited correlation. Precondition, one action and postcondition share a hard deadline. Failed/unknown actions are not replayed, and completed action status is independent from postcondition success. Window discovery, semantic conditions and controls are not an atomic application transaction.

Rust helper uses Windows GUI subsystem; the semantic worker is compiled as winexe with that target included in its content cache key. Explicit inherited GetStdHandle stdin/stdout pipes preserve the UTF-8 protocol without allocating or attaching a console. The actual four-mode acceptance verifies this transport through real native menu lifecycles. Ordinary Node protocol tests cover window-query options, owned versus correlated roots, partial coverage and invalid metadata. Final validation passed `cargo fmt -- --check`, offline `cargo check`, all 29 Rust tests and the offline release build. `pnpm pack --pack-destination .local` passed prepack verification with 85 JavaScript files syntax-checked and 110 tests passing, zero failures, followed by staged executable/source-manifest consistency; it produced `dsh-computer-use-0.5.13.tgz`.

The staged helper also passed the actual Electron native/bridge regression entry, with both completion markers after cleanup. Ten native checks cover fully occluded PrintWindow pixels with foreground preservation, nonfocusable directed messages, actual Button-message activation, stale child PID refusal, resize without activation, modifier/Unicode input, normal key/mouse release, stop/release on focus loss and minimized discovery/restoration. One explicitly not_started read-only snapshot change used bounded reacquisition. Four bridge checks cover the matching Electron ABI149 electron-edge-js runtime, compiler companion, Narrator status and twelve concurrent calls. Narrator was not running; these checks make no speech or virtual-cursor claim.

The real temporary-home CLI/Loader probe reports all 25 tools, standardListView:true, relatedWindows:true, workflowPrompt:true and observationAllowed:true; a separate control attempt is denied by configuration. The probe cleans up its temporary home and does not install into the running GUI. The final default popup entry used the same staged helper for the four fixtures and actual Sound flow described above.

Reproduce with `pnpm run smoke:popups "C:\path\to\DeepSeek Harness.exe"`, using an explicit `DSH_HARNESS_ROOT` when the real test dependency checkout is elsewhere. The default entry runs the four fixtures and then the actual Sound-property flow. Optional `DSH_POPUP_MODES` selects distinct values from native/forms/wpf/external, skips the application stage and writes separate subset metrics with fullAcceptance:false; it is not full acceptance. These results cover controlled framework flows and one actual application. They do not establish a general success rate, installed GUI upgrade, complete capability parity or completion of the broader task matrix.

## Historical 0.5.12 validation — 2026-10-09

0.5.12 adds read-only standard Windows ListView content through `computer_read_control`, bringing the bundle to 25 tools. It accepts a fresh child-window ID from `computer_windows:children` and explicit column indices. Root/child HWND, PID, parent, class and title are checked again before reading. The result has its own `control_read_id` in the `native_standard_control` domain; it supplies neither semantic element IDs nor input coordinates. Child directories retain genuine zero-area helper HWNDs without relaxing the positive-area rules for capture or controls.

The actual Electron 44.0.0 / Node 24.18.1 / ABI149 acceptance uses a real Cordis Context, ToolRuntime, production WindowsComputer and the official managed subprocess service. The tested build, staged release and temporary medium-integrity helper copies share executable SHA-256 `3e280c5edf2cf24ebd0b93c5642d8d8a71616e1380a4a251020c405c36ab0f00`. Ordinary 32-bit and 64-bit WinForms fixtures contain both managed ListViews and native SysListView32 controls. Their 41 recorded entries include readiness, directories, setup and refusals; they are not 41 independent application tasks or a success-rate measurement.

| Task | Observed result |
| --- | --- |
| Both target architectures | Exact managed/native text, requested column order and targetBits 32/64; Chinese and supplementary Unicode survive the remote UTF-16 layouts |
| Native child directory | A genuine 0×0 Static HWND remains listed and does not stop enumeration of the ListViews |
| Row/cell/character/text limits | Explicit partial coverage and completed-prefix counters; conservative capacity-bound text stops the page, and supplementary characters are truncated only at a valid UTF-16 boundary |
| Selection/focus/background | Selected rows 1 and 3 and focused row 3 remain unchanged; disabled controls remain readable, and a focused covering window retains foreground; input count stays zero |
| Unsupported targets | Owner-data, an unknown class and invalid columns are refused; a replaced child identity is rejected before content reading |
| Scalar count timeout/error | Explicit source errors without a remote-buffer quarantine; a later fresh read recovers once the fixture is responsive |
| Delayed row 1 text, both architectures | Row 0 contributes two complete cells; nextRow is 1, failedRow is 1 and failedColumn is 2; callback timeout returns partial coverage and quarantines the remote buffer |
| Late access after timeout | The fixture independently uses VirtualQuery and ReadProcessMemory to verify its original buffer remains readable; three subsequent attempts read zero cells, send no new text request and leave the target handle count unchanged |
| ReplyMessage before writing text | Independent 64-bit fixtures return 777 and 0 early; both fail written-length/first-NUL validation, retain the remote buffer for late access and refuse a later allocation |
| Cancellation and total deadline | ToolRuntime cancellation returns an error in 203ms wall time; timeout_ms 350 returns an error in 373ms wall time, including startup/output; these are single-run observations, not benchmark distributions |

A separate actual-application acceptance opens the system Sound dialog through the official runner at current process permissions. Its standard SysListView32 has five rows: 2490W1G5, P3061, Redmi 238 NFS, 扬声器 and Realtek HD Audio 2nd output. All five message texts exactly match names independently read through the actual UIA tree. A fresh window/child directory followed by another content read returns identical rows, selectedCount 0 and focusedRow null; the foreground identity before and after the reads is identical. The test closes only its own launched Sound process and emits the completion marker after Context, runner, loader and temporary-directory cleanup. It does not change audio settings.

Actual provider/access limitations remain explicit. Explorer's desktop ListView is owner-data and is refused. A Services ListView probe fails its scalar GETITEMCOUNT with Win32 error 5; that establishes access denial, not its cause, and no elevation was attempted. An earlier independent Sound MSAA read failed child enumeration; the final successful comparison uses UIA and retains exact text matching. The earlier failure artifact is preserved.

Pointer-bearing messages use the target process's 32-bit or 64-bit LVITEM layout and one fixed 8192-byte allocation. A named event is copied into the target before allocation; its identity includes target PID and creation time. Callback timeout, helper termination or invalid written text retains the allocation and target-held guard until target exit, and later helpers refuse further allocation for that process. A completed callback alone is insufficient because ReplyMessage can return early: reply length, first NUL and valid UTF-16 are checked before normal release. A custom control that first writes valid text and then keeps using the pointer can violate this protocol; these checks do not prove safety for that behavior. The adapter applies to standard ListViews that obey the text-reply protocol, with owner-data explicitly unsupported.

Row, cell, total-character, per-cell-character and per-message budgets are explicit; one hard total deadline includes queued work and helper startup, without a separate five-second allowance. nextRow advances only across fully read rows, so a partial last row can be retried from its beginning after a budget stop. Source errors carry the known prefix and failure location; a quarantined target must exit before another pointer-bearing read. Counts/rows are separate messages and are not an atomic application snapshot. Full coverage refers only to the requested columns across all rows, and cannot authorize an input action.

Twenty-nine Rust tests pass, including the existing image/input/visual checks and native LVITEM layout/valid UTF-16-prefix checks. The staged executable also passes the actual Electron native and bridge regressions with both completion markers after cleanup: occluded PrintWindow pixels with foreground preservation, directed Panel/Button messages with measured activation, stale child PID refusal, resize, modifier/Unicode input, normal release, stop/release on focus loss and minimized discovery/restoration. One explicitly not_started read-only snapshot change uses the existing bounded reacquisition. Bridge checks confirm electron-edge-js, its compiler companion, Narrator status and twelve concurrent calls. Narrator was not running; no speech or virtual-cursor claim is made.

The real temporary-home CLI/Loader probe reports all 25 tools, standardListView:true, the workflow prompt and observationAllowed:true; a separate control attempt is denied by configuration. The probe cleans up its temporary home and does not install into the running GUI. Reproduce the controlled fixtures with `pnpm run smoke:listview "C:\path\to\DeepSeek Harness.exe"`; append `app` for the actual Sound/Explorer acceptance. `pnpm pack --pack-destination .local` enforces syntax, Node/ToolRuntime tests and executable/source-manifest consistency. Further menu/popup/external-dialog tasks remain under the broader goal. These controlled checks and one actual-application read do not establish general application success, installation or full capability parity.

## Historical 0.5.11 validation — 2026-10-08

0.5.11 adds Windows bounded-region RGB pixel search, system OCR and visual present/absent waits through `computer_find_color`, `computer_ocr` and `computer_wait_visual`, bringing the bundle to 24 tools. These are observations: they neither focus/restore a source nor send input, and their independent `visual_id` is not screenshot or semantic action evidence. A named window retains its observed HWND/PID/title; each capture reads its current whole-window bounds and translates the relative region. Desktop regions use signed native coordinates. Out-of-source regions fail rather than being clipped.

The actual Electron 44.0.0 / Node 24.18.1 / ABI149 acceptance uses a real Cordis Context, ToolRuntime, production WindowsComputer, official managed subprocess and the system `Windows.Media.Ocr` engine. The tested build, staged release and temporary medium-integrity copy share executable SHA-256 `da34b0e6099bb49d5f0ec40e6c1854c11d3017e6cd1e8ac2f3263cd6fa715329`. The ordinary 760×420 WinForms fixture draws text and RGB blocks; it supplies no fabricated query results or OCR scores. Its result contains 24 checks plus the final window/state, 26 recorded entries:

| Task | Observed result |
| --- | --- |
| OCR status | Installed tags en-US, zh-Hans-CN and zh-Hant-TW; maximum image dimension 10000; confidence unavailable |
| Complete exact RGB count | 480 matching pixels across all 4550 region pixels, with only two displayed samples |
| Reverse traversal | Same count; first forward sample (110,260), first reverse sample (159,271) in absolute native coordinates |
| Inclusive per-channel tolerance 2 | 720 pixels match; a block differing by 3 in one channel stays excluded |
| Pixel-limited prefixes | max_pixels 1 gives partial zero; 1311 gives partial one; the known hit satisfies present, while partial zero cannot satisfy absent and times out at its 600ms budget |
| Region-only OCR | ALPHA READY and STATUS WAIT read; OUTSIDE SECRET outside the region is excluded; all word scores are null |
| Rounded enlargement | 521×121 at scale 1.5 becomes 782×182; actual dimensions govern word bbox mapping |
| Word/character limits | One-word output is partial with no fabricated complete line; max_chars 6 also returns a partial word prefix; partial OCR cannot satisfy absent and times out at its 1500ms budget |
| Unsupported requests | min_confidence 0, uninstalled fr-FR and an escaping region each fail explicitly |
| Control policy | Separate controlApproval deny rejects an attempted click; this checks policy denial, not visual-ID credential validation |
| Actual delayed pixel/text changes | Wait observes 480 new-color pixels and the exact ALPHA DONE line after fixture timer changes |
| Text never appears | The 1200ms wait reports unfulfilled timeout within the asserted bound |
| Source loses foreground | Screen-window wait stops with a source error, not successful absence or repeated capture recovery |
| Fully covered target | PrintWindow still reads 480 pixels and ALPHA READY while the explicitly focused cover retains foreground |
| Window moves after listing | The same identity rebases region to (160,270), first matching pixel (170,280), after window origin changes to (140,100) |

The fixture finishes with click count zero and its completion marker after cleanup. Scan samples and true pixel counts are independent. Coverage-limited zero does not establish absence. A complete OCR result describes delivery of the engine output, not accuracy or completeness of the underlying screen text.

A separate actual-application acceptance used the currently running SketchUp 2024 through the same real ToolRuntime/Electron/official runner and new production code. It pinned HWND 257243938 / PID 72400, found the Select/Rectangle buttons and status bar through native UIA, and read Select toggle_state On before switching. Its 20 recorded samples include source evidence, OCR/color observations, four waits and final UIA readback:

| Actual SketchUp task | Observed result |
| --- | --- |
| Chinese Select status | A whole-status region enlarged explicitly by scale 3 reads the main line 单 击 或 拖 动 以 选 择 对 象; Shift/Ctrl symbols are incomplete |
| Select button color | Interior sample RGB (220,237,249); complete 28×28 scan counts 675 matching pixels |
| R switches to Rectangle | Key uses fresh native window evidence window-93d6c4e3-a484-484a-a712-d0e074d91d6e; a fresh list returns window-054a0909-5973-445a-8b6c-2c44a3b3ca30; OCR includes 点 击 设 置 第 一 个 角 |
| Rectangle confirmation | Exact previously observed OCR line fulfills in one attempt / 264ms; Select color becomes complete zero and absent fulfills in one attempt / 200ms |
| Space restores Select | Key uses fresh native evidence window-a875e720-6b32-402d-a54c-6ffbe12f537b; a fresh list returns window-04a41612-1467-4dc3-bec5-2d5d06493b27; main Select status returns |
| Restored confirmation | Observed exact text fulfills in one attempt / 265ms; 675 color pixels fulfill in one attempt / 214ms; a new native query/read confirms toggle_state On |

The only application controls were explicit focus, R and Space; there was no canvas input or model save. Each key used evidence from the native surface and was followed by a fresh observation. These are single-run wait durations, not latency distributions or OCR accuracy estimates. Earlier probes stopped before key dispatch on a read-only source change, incorrectly expected toggle state in a summary, or used a narrow OCR region that missed Chinese characters. Region/scale diagnostics and an interior color sample corrected those probes; production checks and action expectations were not relaxed. The final OCR still has misrecognized key labels (including 褳) and omitted punctuation. Before/after images and raw results are local acceptance artifacts; saving them does not claim image inspection by a model.

Twenty-seven Rust tests pass, including the retained 22 image/input tests, three independent color scan checks, actual-rounded OCR bbox mapping and window-relative rebasing. Fourteen focused visual JS tests pass for regions/options, strict response confirmation, complete/partial counting, OCR geometry/word-line membership and character limits, unsupported scores, hard deadlines, cancellation and source errors. The staged new executable also passed the actual Electron native expansion and bridge regressions, with both completion markers after cleanup: occluded PrintWindow pixels/foreground preservation, directed Panel/Button messages with measured application activation, stale child PID refusal, resize, modifier/Unicode input, normal key/mouse release, stop/release on focus loss, and minimized discovery/restoration. One explicitly not_started read-only snapshot change used the existing bounded reacquisition. Bridge checks confirm electron-edge-js, its compiler companion, Narrator status and twelve concurrent calls. Narrator was not running; there is no speech or virtual-cursor claim.

The required source region and enlarged OCR image each have a 16,000,000-pixel limit; PrintWindow full rendering retains its 64,000,000-pixel limit. Screen-window capture requires foreground, visibility and non-minimized state and rechecks identity/bounds; print_window does not activate the source and has no screen fallback. OCR uses one explicit scale 1–4 with Lanczos3 and maps bboxes using actual rounded dimensions. Word and line texts share the character budget; a truncated final word group may lack a complete line. The engine provides no confidence API, so words/lines report confidence:null and every min_confidence request is rejected. Explicit language must be installed; no invented score or silent language substitution is supplied.

Visual waits share one monotonic deadline, linked cancellation and remaining-budget managed subprocess calls without an extra five-second allowance. Known partial hits can satisfy present; absent requires complete output. OCR absence means no recognized match, not proof of no visible text. Source errors stop immediately. Pixel locations are observations, not business-object identities or input authorization, and the system offers no transaction across observation and later controls.

Reproduce the controlled region acceptance with `pnpm run smoke:visual "C:\path\to\DeepSeek Harness.exe"`; native/bridge regression with `pnpm run smoke:images "C:\path\to\DeepSeek Harness.exe" native bridge`. `pnpm pack --pack-destination .local` runs the required syntax, Node/ToolRuntime and executable/source-manifest checks. SketchUp was exercised independently with new code; the installed GUI was not upgraded or restarted. Standard Win32 content adapters and further menu/dialog tasks remain under the broader goal. The controlled checks and one actual-application flow do not establish a general application success rate, installation or full capability parity.

## Historical 0.5.10 validation — 2026-10-08

0.5.10 extends the complete screen-resolution scan with explicit RGB comparison, alpha exclusion and one nearest-neighbor template ratio. Gray remains the default. An RGB pixel matches only when all three channels satisfy tolerance; the threshold denominator is the number of participating pixels. Alpha mode includes pixels whose alpha is >= the requested cutoff, without background compositing or alpha weighting. The same scanning kernel handles all modes, with the existing coverage, fixed-anchor clustering and partial-click refusal rules.

The actual Electron 44.0.0 / Node 24.18.1 / ABI149 acceptance uses the real Cordis ToolRuntime, production WindowsComputer, official local subprocess service and an ordinary 600×360 WinForms pixel canvas. The fixture draws native pixels, generates PNG inputs and reports actual MouseUp counts/client coordinates. The staged 0.5.10 executable SHA-256 is `3eb899748d201668c6f1f2e071c1325220b704ef5a48678a5c4389e54bb7274a`, identical to the tested build and its temporary medium-integrity copy. All image cases use threshold 1 / tolerance 0:

| Task | Observed result |
| --- | --- |
| Existing gray coverage tasks | Two targets and crowded distractors both report two clusters across all 194,449 positions; final-position match and complete no-match remain correct; partial zero/one matches refuse clicks |
| Same-luma color distractor | Gray reports two clusters and refuses the click; RGB reports one exact target, then dispatches one MouseUp at client (212,172) |
| RGB prefix with one known target | Partial 92,521/194,449 positions, one cluster; click refused |
| Explicit downscale | A 48×48 source PNG at template_scale 0.5 becomes 24×24 and finds one target; result reports source/actual dimensions and capture scale 1 separately |
| Alpha template without mask | Complete scan finds no match and refuses the click |
| Alpha cutoff 1 / cutoff 128 | Cutoff 1 includes 196 pixels with the half-transparent ring and finds no exact match; cutoff 128 includes 144 opaque pixels and finds one target |
| Independent alpha screen read | GetPixel compares all 144 included pixels with the PNG and reports zero differences; accepted click produces MouseUp at client (312,112) |
| Fully transparent / flat visible template | Explicit native errors; hidden transparent RGB cannot manufacture participating contrast; no additional MouseUp |
| Native-size template against doubled pixels | Complete zero-match scan at template_scale 1; click refused |
| Explicit upscale | A 24×24 source at template_scale 2 becomes 48×48, scans all 173,089 positions and finds one target with 2304 participating pixels; MouseUp at client (264,204) uses the transformed center |
| RGB + alpha 128 + scale 2 prefix | Partial 122,041/173,089 positions, one known cluster and 576 participating pixels; click refused |
| Complete combined mode | One cluster across all 173,089 positions; exactly one additional MouseUp at client (404,244) |

The complete image run ends with exactly five MouseUp events: the retained gray unique case, RGB, alpha, scale 2 and their combined mode. Each control uses a freshly listed tool window ID; subsequent application state and another list verify the result. Its completion marker was emitted after cleanup. Earlier full attempts stopped on an unexpected alpha no-match and an extra MouseUp respectively; the available evidence does not establish their causes. An isolated alpha probe verified the 144 screen pixels before the final complete run passed. These runs did not change the production algorithm, relax the expected click counts or replay failed actions automatically.

Twenty-two Rust tests pass: fourteen common matching-core tests, five template preparation tests and the three existing input tests. New coverage includes per-channel RGB tolerance, masked threshold boundaries, an independent masked RGB brute-force oracle, partial/timeout results, same-luma structure, inclusive alpha cutoffs, hidden-only contrast refusal, nearest resizing and zero/resource/invalid-option errors. Twelve focused JS tests pass for requested-mode confirmation, source/transformed geometry, participating counts, legacy helper refusal, position budgets and complete-only click centers.

The staged executable also passed the actual Electron native expansion and bridge regressions, with both completion markers after cleanup. Native checks cover target PrintWindow pixels under full occlusion with foreground preserved, Panel/Button messages and measured activation, stale child PID refusal, resize, modifier selection/Unicode, normal key/mouse release, stop-and-release on focus change, and minimized-target discovery/restoration. The existing bounded reacquisition handled one explicitly not_started read-only snapshot change. Bridge checks confirm electron-edge-js, its compiler companion assembly, Narrator status and twelve concurrent calls. Narrator was not running; status does not claim observed speech or virtual-cursor movement.

The protocol confirms `colorMode/maskMode/alphaMin/templateScale`, source and transformed dimensions, `resizeFilter:nearest` and `activePixelCount`; a legacy helper cannot silently ignore a requested mode. Source and transformed templates are each limited to 1,048,576 pixels. Nearest resize uses one finite ratio 0.1–4 and positive rounding with .5 up; zero dimensions, empty masks and participating contrast below 3 are refused. Retained half-transparent pixels compare PNG color directly, which can differ from their screen-composited color. No automatic multi-scale search or application-object identity is provided. Capture scale 1 means no screen downsampling. Partial coverage still cannot prove absence or uniqueness, and screen/window changes between search and input still require application-result verification.

Reproduce with `pnpm run smoke:images "C:\path\to\DeepSeek Harness.exe"`; optional final arguments `image`, `native`, `bridge` select relevant modules. `pnpm pack --pack-destination .local` enforces syntax, Node/ToolRuntime tests and executable/source-manifest consistency. The semantic twelve-module suite was delivered at 0.5.8; this stage did not change its C# worker. OCR/pixel, standard Win32 content adapters and further menu/application tasks remain under the broader matrix. The research documents retain their frozen baseline; this controlled pixel acceptance does not establish general application task success, installation or installed-package parity.

## Historical 0.5.9 validation — 2026-10-08

0.5.9 repairs image candidate counts that could not establish complete search coverage. Production now evaluates every legal original-resolution top-left position, retaining only sound per-position early rejection. Grayscale tolerance and the fraction-of-matched-pixels threshold remain the scoring rule. Threshold decisions use the same division as final scoring, including exact 0.9/0.95 boundaries.

The actual Electron 44.0.0 / Node 24.18.1 / ABI149 image acceptance connects the real Cordis ToolRuntime, production WindowsComputer, official local subprocess service and an ordinary borderless 600×360 WinForms pixel canvas. The fixture generates a 24×24 PNG, draws the same native pixels without scaling, and reads its actual MouseUp count and client coordinates after each tool action. It does not supply fabricated match results or accessibility identities. The new build SHA-256 is `222010162545be45984845bf7e30f235bbe126dad75b310f7e99c555913d6f15`; the temporary medium-integrity helper copy has exactly the same bytes. All cases use threshold1/tolerance0:

| Task | Observed result |
| --- | --- |
| Two identical templates | Complete coverage of 194,449 legal positions; two clusters; click refused and MouseUp count remains zero |
| Nine nearby coarse-equivalent distractors and two real templates | New helper reports both real matches, including the distant target; click refused. The unchanged 0.5.8 helper on the same drawn screen reports only the early match, `matchCount:1`, and no coverage field |
| Unique match at the final legal position | Complete scan returns client576,336 / screen616,396 with one cluster |
| No drawn template | Complete `not_found`, zero matches; click refused, zero MouseUp |
| Position budget one | Partial/incomplete, visited1/194449, no known hit; click refused without claiming absence |
| Position budget23,121 | Partial/incomplete with the early hit and unknown tail; click refused even though `matchCount:1` |
| Complete unique target | Tool dispatch produces exactly one MouseUp at client212,172 / screen252,232; a fresh window list and application state verify the result |

The previous-helper counterexample used the already-delivered executable SHA-256 `9a86acbb39edde4d36972c913fb5b5dd594e50a8e944386016e63bdd8b10b789`. Distractors preserve each 4×4 block average while changing fine pixels, occupying the old top-eight coarse candidates before the distant match. This establishes the specific false-unique failure and its repair on one controlled screen, not general application task success. The image module delivered its completion marker after cleanup.

Ten matching-core Rust tests and the three existing input tests pass. They cover full tail coverage, duplicate targets, eleven clusters despite an eight-row display limit, threshold boundaries, exact position budgets, partial zero/one counts, timeout and cluster-capacity reasons, fixed-anchor clustering, small/oversized templates and agreement with a separate brute-force threshold check. Nine focused JS policy tests pass for integer budgets/tolerance, negative desktop coordinates, coverage/count consistency, legacy helper refusal, invalid geometry and partial-click rejection. No runtime context is mocked in the native acceptance.

The staged new native executable also passed the actual Electron native expansion and bridge modules, each with its completion marker. Expansion checks cover PrintWindow pixels under full occlusion with foreground preserved, Panel/Button messages and measured application activation, stale child PID refusal, resize, modifier selection/Unicode, normal key/mouse release, stop-and-release after focus changes, and minimized-target discovery/restoration. The initial test setup failed to acquire the occluding foreground; the fixture now explicitly focuses its freshly listed owned cover before testing background preservation. A source-change error during later snapshot reading led to bounded reacquisition of only a `not_started` read; actions and expected application effects were not replayed or weakened. Bridge checks confirm electron-edge-js, its companion assembly, Narrator status and twelve concurrent calls.

`coverage:"partial"` always pairs with `status:"incomplete"` and a time/position/cluster stop reason. `found` denotes known hits only, and `matchCount` is a lower bound until coverage is complete. The fixed rule `row_major_fixed_anchor_half_template` groups positions around the first row-major hit within half-template width/height; the first anchor never moves, so continuing the scan cannot reduce the prefix count. A cluster's displayed point may improve in score. Counts include all clusters; only the highest eight are displayed. At most 100,000 clusters are retained, with partial coverage on capacity exhaustion.

Matching still discards RGB hue and alpha, supports only native template scale, and refuses grayscale standard deviation below3. The old implicit 16×16 coarse-template minimum is gone; templates are bounded at1,048,576 pixels. Nearby business objects can share a visual cluster. Search coverage describes the captured image; it is not a transaction with the subsequent click, and screen/window changes in that gap require application-result verification. Native budget covers decode/preparation/capture/search; a blocked system call is terminated by the host deadline with five seconds of startup/output allowance and returns an error rather than invented partial success.

Reproduce with `pnpm run smoke:images "C:\path\to\DeepSeek Harness.exe"`; optional final arguments `image`, `native`, `bridge` select only relevant modules. The default image test uses the staged native helper; `DSH_IMAGE_HELPER` can explicitly select a build, and `DSH_IMAGE_PREVIOUS_HELPER` enables the historical executable counterexample. `pnpm pack --pack-destination .local` enforces syntax, Node/ToolRuntime tests and executable/source-manifest consistency. The semantic twelve-module suite was already delivered at0.5.8; this image-only change did not alter its C# worker. OCR/pixel/mask/template-scale and standard Win32 content adapters remain implementation work under the broader task matrix. No installation, application restart or installed-package parity is claimed.

## Historical 0.5.8 validation — 2026-10-08

0.5.8 adds Windows window-relative hierarchical locators, read-only condition waits and one-action/result-confirmation flows. Locator steps resolve uniquely or use an explicit zero-based nth; ambiguity stops rather than choosing a candidate. Node/depth/time truncation is incomplete, and absence requires complete coverage of the requested exposed-tree scope. All polling stays pinned to the original HWND/PID/title, re-resolves container replacements and shares one deadline with the action and postcondition. Unknown or failed actions are not replayed.

The new task acceptance connects the real Cordis ToolRuntime, production WindowsComputer/managed worker and default WPF AutomationPeers. It creates ordinary WPF controls; it does not supply a fabricated accessibility provider or mock native query results. The initial ordinary Node run and the latest full actual Electron suite passed the tasks below; the added removed-reference, post-action manual-edit and window-title checks were verified in Electron:

| Task | Observed result |
| --- | --- |
| Two same-name Apply buttons | Two candidates report ambiguous; explicit nth selects a prefix with partial coverage |
| Node-budget truncation / actual missing target | Incomplete coverage cannot satisfy absent; fully searched exposed scope can |
| Entire container and Edit replacement | Wait sees the new element ID and enabled state; SetValue is read back as updated |
| Invoke and delayed status | Action count becomes one and the delayed postcondition is confirmed |
| Postcondition timeout / cancellation | Timeout leaves count at two, with no replay; cancelled read-only wait sends no additional action |
| Evidence isolation | Another agent cannot use the listed window ID |
| Lazy TreeView | One expand, delayed leaf appears, select and read confirm selected |
| Virtualized ListBox of 600 strings | Find item579, realize the exact placeholder object, re-resolve and select successfully |
| DataGrid cell | Grid.GetItem produces a separately registered snapshot, selection works and selected state is read back |
| Concurrent desktop interaction | While waiting on disabled input, another same-name window actually gains foreground, the original input is manually edited and replaced; the pinned original window is updated, and the other window keeps its value with action count zero |
| Removed WPF reference | Synchronously replace the whole container after observing its input; the old reference is rejected and the new input keeps its initial value |
| Manual edit after dispatch | Real SetValue returns, then the fixture changes the value before the real postcondition read; confirmation fails, dispatch count remains one, and the manual value is preserved |
| Window title changes | The same HWND/PID changes title after observation; control using the old element is rejected without a write |
| Separate HWND popup | Action opens popup; a fresh list identifies it; confirm is sent once and another list verifies it closed |

The concurrent case records the final foreground independently: the other window was observed in foreground during the wait but was no longer foreground at completion in both the ordinary Node and latest Electron samples. Foreground need not remain constant, and application/provider actions may change it. UIA/MSAA do not offer an atomic transaction between a before-condition read and a later action; concurrent edits during that gap still require checking the actual execution state and result. Failed postcondition confirmation leaves the manual value in place and does not replay SetValue. These checks do not establish arbitrary application task success.

The removed-reference acceptance first reproduced a detached WPF peer that still exposed its runtime ID, ordinary properties and old parent chain and could accept SetValue. Production now checks every parent/child edge against the parent's current direct-child list using exact runtime identities. It alternates from the first and last child, reads no unrelated sibling names or patterns, and retains a 128-ancestor / 20,000-child-identity limit and the original host deadline. This avoids a full scan before validating a tail child in the flat 10,000-node fixture; the original 500ms Invoke acceptance still dispatches once before the blocking action times out. Attachment checks consume the action budget and do not create a UIA transaction.

The WPF ItemContainer returned `COMException` HRESULT `0x80040201` on an unrealized item before ordinary property acquisition. Production now recognizes only that explicit UIA unavailable code or ElementNotAvailableException, checks VirtualizedItem support and retains the exact returned object under a worker placeholder ID; it does not invent a UIA runtime identity or rebind by name. Placeholder references retain owner/window/lifetime/structure validation, validate attachment of their exact originating container and allow only Realize. Describable items retain their normal complete references; other COM failures propagate.

The initial `pnpm run verify` passed 66 JavaScript syntax checks and all 80 tests, including the real ToolRuntime fault/deadline tests. The new locator contract tests use real Cordis services with fault injection confined to the computer provider. The ordinary WPF timeout sample used a 1500ms total deadline and completed confirmation timeout in 1503ms; the latest full Electron sample completed it in 1528ms. These are shared-desktop samples, not universal latency guarantees.

The complete sequential actual Electron 44.0.0 / Node 24.18.1 / ABI149 suite passed all twelve modules, each with its completion marker and no failure marker: bridge, semantic focus, expansion, MSAA, live 10,000-node trees, frozen 10,000-node snapshots, recovery, native match limits, real native ToolRuntime, lifetimes, source consistency and WPF locator tasks. ToolRuntime UIA/MSAA results contain 1607/1601 rows over 13 pages each, with zero continuation native acquisitions and one capture recovery/restart. The source-consistency counterexample still reproduces on both backends; the production source-atomic adapter remains unimplemented. The 0.5.8 manifest matches the unchanged executable and Rust/Cargo source hashes.

Reproduce the new task acceptance with `pnpm run smoke:locators`, or run the twelve-module suite with `pnpm run smoke:electron "C:\path\to\DeepSeek Harness.exe"`. `pnpm pack --pack-destination .local` requires syntax, Node/ToolRuntime and native-manifest gates before packaging. The research baseline is retained in [complex UI automation](references/COMPLEX-UI-AUTOMATION.md); the image candidate/uniqueness repair, OCR/pixel/mask/scale capabilities and standard Win32 content adapters remain further implementation work. No new deployment or installed-package parity is claimed.

## Historical 0.5.7 validation — 2026-10-07

0.5.7 adds an optional `computer_find(source:"native", max_matches:K)` for Windows snapshot queries. The production collector stops after K matches, rereads every covered hit and miss in the same traversal order, then freezes that prefix. It reports `coverage.source_status:"partial"` / `source_reason:"match_limit"`; page budgets are independent. An absent limit retains the previous bounded-scope search. No source-wide transactional guarantee is added.

| Backend | Default query covered nodes | Three-match prefix covered / reread nodes | Frozen output pages (one row each) | Continuation acquisition calls |
| --- | ---: | ---: | ---: | ---: |
| UIA | 135 | 29 / 29 | 3 | 0 |
| MSAA | 129 | 23 / 23 | 3 | 0 |

The dedicated actual Electron 44.0.0 / Node 24.18.1 acceptance passed both backends using the real WindowsComputer, official Cordis subprocess service and owned native providers. Source renames and reordering after sealing preserve the three original names and fixed result ID/digest. A covered miss becoming a match and covered-node reordering both discard an unpublished prefix and its cursor. Matched summaries still expose bounds and invoke; each backend executes one action, then rejects a renamed identity without another effect. Native and JS entry points reject invalid limits and live-mode limits. A limited query with no match still searches the full scope and returns complete empty coverage.

For a 10,000-node source, the next item (index1) and a distant item (index9998) were configured to block their name getters for 60 seconds. A one-match query for item0 froze within its 5-second tool deadline: UIA covered eight nodes in 909ms including cold worker startup, and MSAA covered two nodes in 21ms with the worker already running. The complete prefix reread ends before navigating the unsearched next sibling. These timings verify bounded completion in this fixture; the different startup states are not a backend speed comparison.

The extended real native ToolRuntime chain also passed: 41 matches cover 48 UIA / 42 MSAA nodes and output three pages at the default 20 matches per page. Continuations inherit an omitted limit, accept the unchanged limit with repeated selectors, and reject a changed limit before consuming the cursor. Source renaming, reordering and UIA insert/remove between pages leave the original 41 rows unchanged; continuation native acquisition calls and UIA provider counters remain zero, and final source coverage remains partial. The existing default 13-page chain still passes observation eviction, consumed history evidence, cross-agent isolation, native identity rejection and one capture restart.

The complete sequential actual Electron suite passed all eleven native modules, each with its completion marker and no failure marker. It includes the new match-limit acceptance and the existing bridge/ABI, WPF/pattern/MSAA actions, live and fixed 10,000-node trees, recovery, native ToolRuntime, lifetimes and source-consistency checks. The full-suite blocked-tail sample also completed within budget (UIA400ms / MSAA25ms). The source-consistency counterexample still reproduces the nontransactional boundary; its passing check is not evidence of a source-atomic repair. The 0.5.7 native manifest matches the unchanged executable and Rust source hashes.

Reproduce the dedicated check with `pnpm run smoke:matches`, or run it and the existing native regressions through `pnpm run smoke:electron "C:\path\to\DeepSeek Harness.exe"`. `pnpm pack --pack-destination .local` requires the syntax, Node/ToolRuntime and native-manifest gates before packaging.

## Historical 0.5.6 validation — 2026-10-07

0.5.6 connects the real DSH ToolRuntime, production WindowsComputer, official Cordis local-subprocess service and owned native UIA/MSAA providers in one acceptance test. The host's current workspace source is loaded with its own TypeScript aliases, as in the existing ToolRuntime integration test; no runtime services or native provider responses are mocked.

| Backend | Frozen rows | Output pages | Initial frozen acquisition calls | Frozen continuation acquisition calls |
| --- | ---: | ---: | ---: | ---: |
| UIA | 1,607 | 13 | 1 | 0 |
| MSAA | 1,601 | 13 | 1 | 0 |

The targeted actual Electron 44.0.0 / Node 24.18.1 run passed both backends. It keeps the default eight semantic observations per agent while advancing all 13 pages, so the continuation chain crosses real tool-level eviction. Result IDs and SHA-256 digests stay fixed after post-seal source renames and reordering; UIA additionally inserts and removes a node. The native acquisition counters and instrumented UIA provider counters remain zero across frozen continuations.

The same chain invokes a registered target once, then rejects consumed first-page evidence and every subsequent history-page action without another side effect. Another agent cannot borrow a cursor. A newly observed target renamed before invocation is rejected by native identity checks. An unfinished generation changed after reading node12 fails and discards its cursor; a fresh query silently changed after reading node12 restarts once and returns the changed match. Source-scope completeness and output-page completeness are checked separately.

The first attempt to run this combined test exposed an Electron invocation returning exit zero despite a module-loading error. Native smoke checks now require a per-module completion marker emitted only after its awaited test and cleanup finish, reject any failure marker, and continue to reject nonzero exits and timeouts. Real subprocess regressions cover normal completion, an early exit zero, missing-module loading and a late exception whose outer exit is reset to zero. Source-wide transactional atomicity remains outside these verified guarantees; no capability field is promoted by the completion marker.

The complete sequential Electron suite passed all ten native modules, each with its completion marker and no failure marker: bridge/ABI, WPF semantic actions, pattern expansion, MSAA actions, live large trees, fixed large-tree pagination, change recovery, the combined native ToolRuntime chain, lifetimes and the source-consistency counterexample. The 0.5.6 native manifest also matches the unchanged executable and source hashes. The source-consistency test still reproduces the nontransactional source boundary; its passing assertion establishes detection of that limitation, not its repair.

Reproduce the combined acceptance and existing native checks with `pnpm run smoke:electron "C:\path\to\DeepSeek Harness.exe"`; run the completion regressions with `node --test test/electron-smoke.test.js`. `pnpm pack --pack-destination .local` runs the syntax, Node/ToolRuntime regressions and native-manifest gates before producing the package.

## Historical 0.5.5 validation — 2026-10-07

0.5.5 applies scoped caching and bounded read-only reacquisition from the [mature desktop automation implementations](references/DESKTOP-AUTOMATION-IMPLEMENTATIONS.md). Query misses retain and reread the fields used to decide matching and the covered tree order; matched rows retain full summaries. UIA runtime IDs are fetched with the navigation cache and remain live-checked before actions. MSAA misses skip location and default-action getters.

A structured capture-change error carries the original HWND/PID/title. A fresh unpublished snapshot may restart at most twice on that window within the same absolute tool deadline. It cannot restart a caller-owned cursor, a live observation, an action, an unknown execution state, a resource/lifetime failure or a cancelled request. Returned observations include `capture_restarts`. No new source-program integration is required for ordinary UIA/MSAA automation.

| Check | Measured result | What it establishes |
| --- | --- | --- |
| `pnpm run verify` | 58 JavaScript syntax checks; all 67 tests passed, including real DSH ToolRuntime | Structured error propagation, bounded observation restarts, window pinning, shared deadline, cancellation/cursor exclusions and existing evidence/control contracts |
| Owned-provider silent query-miss change, UIA and MSAA | Both passed in ordinary Node and actual Electron | Reading node13 changes already-read node12 from nonmatch to match; the unpublished generation is discarded, one restart returns the new name with supported invoke pattern |
| Persistent silent changes | Both passed; exactly three attempts before `COMPUTER_SNAPSHOT_CHANGED` / `not_started` | Two restart limit is enforced; the worker remains usable after changes stop |
| Caller-owned capture cursor | Both passed | A changed generation fails and is removed; the old cursor cannot become a different result |
| Current action identity | Both passed | A valid registered reference invokes exactly once; after source rename the old reference is rejected and does not execute another action |
| `pnpm run verify:profile` and native manifest check | Both passed at 0.5.5 | Temporary real Loader mounted all 18 tools and workflow prompt, allowed observation and denied configured control; unchanged native executable/source hashes match the versioned manifest |
| Actual Electron 44.0.0 / Node 24.18.1 / ABI 149 | All nine sequential native checks passed | Runtime-matched bridge, WPF/MSAA controls, live/frozen large trees, recovery, lifetime and source-consistency boundary remain usable |
| Immutable native pagination | 10,020 UIA rows and 10,001 MSAA rows, each in 31 pages | Fixed result ID/digest across post-seal insertion/deletion/reorder/rename; frozen continuations acquire no native data |

The recovery fixture compares a one-match query with full-summary acquisition on the same resized owned window. Both paths cover and reread exactly the same nodes. The successful Electron run measured:

| Backend/path | Covered nodes | Client native-call counter | Provider property reads | Provider pattern reads |
| --- | ---: | ---: | ---: | ---: |
| UIA full summary | 135 | 540 | 3,608 | 4,644 |
| UIA one-match query | 135 | 542 | 2,340 | 36 |
| MSAA full summary | 129 | 1,804 | — | — |
| MSAA one-match query | 129 | 1,298 | — | — |

The UIA client counter counts a cache request as one operation regardless of how many properties/patterns it requests; the provider counters expose the reduced work. The UIA query needs two additional summary cache requests for its matched row. MSAA provider-level counters are not instrumented by this fixture, so its comparison uses selected client calls only. Query results keep their patterns and bounds. These are controlled read-count comparisons, not universal latency or task-success claims.

The same Electron run acquired the first frozen full UIA page in 10,839ms with 40,082 instrumented client calls; full MSAA in 37,420ms with 140,013 calls over two tool calls; and a separate 167-node, one-match UIA query in 118ms with 670 calls. The full UIA baseline from 0.5.4 recorded 60,120 calls; caching runtime IDs removes the explicit per-node identity acquisition calls. These are ordered samples on a shared desktop with the compiled worker cached; hidden OS/provider operations are not counted as client calls. Frozen MSAA still needs an empty progress page and a second tool call under the default 30-second deadline.

The ordinary Node recovery run also passed both backends. Additional full-scope, lifetime and blocking evidence comes from the actual Electron suite. GUI fixtures own their processes/windows and run sequentially. `source_atomic:false` continues to describe source transaction semantics accurately; the adversarial mutual-exclusion counterexample still reproduces while immutable result pagination remains correct. Coverage and retry do not promote that field to true.

Reproduce with `pnpm run verify`, `pnpm run smoke:recovery`, and `pnpm run smoke:electron "C:\path\to\DeepSeek Harness.exe"`. The source comparison explains what was adopted and what was deliberately excluded. The historical sections below record earlier checks and measurements.

## Historical 0.5.4 validation — 2026-10-07

The 0.5.4 repair closes an in-segment lifetime gap in fixed semantic captures. Previously expiration was checked only at the segment entry: a native read starting before the 120-second capture limit could finish after it and still seal/publish the result. Acquisition now checks its monotonic lifetime after native reads and before sealing. Page construction checks before and after retaining output rows. Expiration discards the generation, cursors and registered references. UTC timestamps remain presentation metadata; lifetime and fixed-result eviction ordering use `Stopwatch` and are not extended by wall-clock adjustments.

| Check | Measured result | What it establishes |
| --- | --- | --- |
| Old-code regression reproduction | The real UIA test failed with `expired capture/result was delivered instead of discarded` before the production fix | A 1200ms owned-provider property read crossing a capture with 1000ms remaining exposed the missing in-segment expiration check |
| Native lifetime smoke, UIA and MSAA | Both passed in ordinary Node and actual Electron | Expiration during native acquisition publishes no result and removes the generation; its cursor cannot resume; references are removed; the same native process can begin another capture |
| Monotonic frozen lifetime | Both backends passed | A frozen generation with an expired monotonic timestamp is rejected even when its UTC display timestamp is in the future; its continuation/references are discarded |
| `pnpm run verify` | 55 JavaScript syntax checks; all 62 tests passed | Existing tool/runtime, worker deadlines, coverage, identity and consumed-evidence contracts remain valid |
| `pnpm run verify:profile` | Temporary real Loader profile passed | All 18 tools and workflow prompt mounted; observation allowed, explicit control denied; semanticSnapshots:true and semanticSourceAtomic:false remain accurate |
| Actual Electron 44.0.0 / Node 24.18.1 / ABI 149 | Complete sequential bridge, WPF, MSAA, live-tree, frozen-tree and lifetime suite passed | Runtime-matched bridge and all previously verified native behavior remain usable after the lifetime change |
| Immutable native pagination | 10,020 UIA rows and 10,001 MSAA rows, each in 31 pages | Result ID/digest remain fixed across pages; post-seal source changes do not change retained rows; continuations still make zero provider acquisition calls |

The lifetime fixture compiles the production C# sources with a separate test entry. Only that entry moves its process-private capture timestamps near the deadline and verifies the registries; it does not modify the machine clock or the production 120000ms lifetime constant. The owned window delays the name property of node 12 for 1200ms. The delay is disabled by default in the shared large-tree provider. The pre-fix regression was run against the same test before changing production code; both UIA/MSAA then passed after the repair. These checks validate expiration and immutable result pagination, not source-wide transactional atomicity.

The successful 0.5.4 Electron run measured the first frozen page as follows:

| Scope | Covered nodes | Returned rows in result | First frozen page ms | Tool calls | Instrumented native calls across capture/validation |
| --- | ---: | ---: | ---: | ---: | ---: |
| UIA full bounded fixture | 10,020 | 10,020 | 10,945 | 1 | 60,120 |
| MSAA full bounded fixture | 10,001 | 10,001 | 39,099 | 2 | 140,013 |
| UIA exact query on resized fixture | 167 | 1 | 171 | 1 | 1,000 |

These are ordered samples on a shared desktop with the compiled worker cached, not universal or cold-compiler latency claims. MSAA continues the same unpublished generation across two tool calls under the default 30-second per-call deadline. Source-wide atomicity remains unimplemented: a two-pass check and change events do not prove all source fields coexisted at one instant. The retention/coverage/action boundaries described below remain applicable; this version additionally enforces in-segment capture expiration and monotonic fixed-result lifetime.

Reproduce from the repository with `pnpm run verify`, `pnpm run verify:profile`, `pnpm run smoke:lifetimes`, and `pnpm run smoke:electron "C:\path\to\DeepSeek Harness.exe"`. Stage and pack with `pnpm run native:stage` and `pnpm pack --pack-destination .local`; prepack checks the current version against the native executable/source manifest. Rust/executable bytes are unchanged.

## Source-consistency investigation after 0.5.4 — 2026-10-07

A real provider counterexample now tests the outstanding source guarantee directly. Two nodes have mutually exclusive active states under one source lock. Reading the left name silently selects one state; reading the right selects the other. Collection and the full second pass both read `Pair left active` and `Pair right active`, although the source invariant never allows both active together. The production worker accepts and seals these matching summaries, keeps pagination immutable, and correctly reports `source_atomic:false` even when coverage is complete. This experiment demonstrates the remaining implementation gap; it is not a source-atomicity repair.

| Check | Measured result | What it establishes |
| --- | --- | --- |
| Real UIA and MSAA counterexample | Both reproduced in ordinary Node and actual Electron | UIA covered and reread 39 nodes, MSAA 33; agreeing reads can contain a combination that never existed at the source |
| Frozen continuation after another source change | Same result ID/digest; zero provider acquisition calls | Fixed result pagination remains immutable independently of source atomicity |
| Test-provider version and locked export | Pair version advanced from 0 to 6; every locked pair export preserved its mutual-exclusion invariant | A cooperating source can expose evidence that detects these silent round trips or export the pair under a shared lock; this pair-only prototype is not a production whole-tree adapter |
| `pnpm run verify` after adding the experiment | 56 JavaScript syntax checks; all 62 tests passed | Existing tools, resources and runtime contracts remain valid |
| Actual Electron 44.0.0 / Node 24.18.1 / ABI 149 | Complete sequential native suite, including the new counterexample, passed | Shared-provider additions preserve the existing WPF/MSAA actions, live/frozen large-tree traversal and lifetime checks |

The initial experimental depth 2 stopped at a partial-coverage assertion because the UIA window decorations extend beyond that depth. With depth 20, the complete small window reproduces the same impossible pair. The test source resets a version only after changing its source-instance ID, and this adversarial mode is disabled by default. The unchanged production implementation and version remain 0.5.4; this follow-up adds test evidence and an adapter contract rather than declaring an atomic adapter implemented.

Run `node test/win32-semantic-source-consistency-smoke.mjs` directly, or use the Electron smoke command above, which now includes it. The [source-consistency contract](references/SOURCE-CONSISTENCY.md) specifies the source identity, coverage, shared-write protection, reliable version/freshness, native action binding and bounded lifecycle needed for implementation. It also records the checked Microsoft cache and remote-operation contracts. This historical investigation did not implement source-wide atomicity. Subsequent ordinary-automation work proceeds through scoped caches and bounded read-only reacquisition without requiring an application-side adapter; the additional transaction contract remains specific to sources that expose it.

## Historical 0.5.3 validation — 2026-10-07

The dynamic-tree repair establishes immutable result pagination on Windows UIA/MSAA. It does **not** establish a transactionally atomic snapshot of the source application. Results report `source_atomic:false`; the provider advertises `semanticSnapshots:true` and `semanticSourceAtomic:false`. These are separate guarantees, and the second remains unimplemented.

Windows now defaults to `consistency:"snapshot"`: collect the bounded scope, reread all covered summaries in order (including native-query misses), compare fingerprints and change versions, then seal the retained rows. No elements are published before validation completes. Frozen pages share a result ID and SHA-256; they do not reacquire data from the provider. The digest covers validated summaries and order before action tokens are registered. Explicit `consistency:"live"` retains streaming acquisition and reports unverified page consistency.

| Check | Measured result | What it establishes |
| --- | --- | --- |
| `pnpm run verify` | 54 JavaScript syntax checks; all 62 tests passed | Existing budgets, worker lifecycle and real ToolRuntime contracts; frozen continuation preserves result identity/time and cannot restore consumed action evidence; AX/AT-SPI reject unsupported consistency selection before launching |
| `pnpm run verify:profile` | Temporary real Loader profile passed | All 18 tools, workflow prompt, snapshot capability fields, allowed observation and explicit control denial mounted; temporary home removed |
| Actual Electron 44.0.0 / Node 24.18.1 / ABI 149 | Complete sequential bridge, WPF, MSAA, live-tree and frozen-tree suite passed | Runtime-matched bridge with 12 concurrent calls; existing focus/value/toggle/invoke, 8 WPF and 5 MSAA checks; live paging, virtualization, blocked-worker termination and recovery remain usable |
| Immutable native pages | 10,020 UIA rows and 10,001 MSAA rows, each in 31 pages | Same result ID/digest across pages; source renaming and silent insert/delete/reorder after sealing do not alter retained rows; each continuation reports zero native acquisition, visited and validated calls |
| Provider counters on frozen UIA continuations | Property reads, pattern reads, navigations and runtime-ID reads all zero | Pagination reads retained data without consulting the live provider, even after the owned source changes |
| Changes during unpublished capture | Silent/event name changes, insertion, deletion and reorder passed; MSAA same-count reorder/name changes passed | Full covered-node verification catches these changes outside the eight live navigation anchors, publishes no elements and discards the generation; its old cursor cannot resume |
| Native query misses | A previously nonmatching covered node becoming a match invalidated capture; a fresh capture returned that match | Verification includes nonmatches rather than only checking rows that were retained for output |
| Identity and output bounds | Renamed frozen UIA target action rejected with stale_target; a nonempty frozen page with continuation stayed within 4,096 serialized bytes | Historical data does not bypass the current target check; page byte accounting includes reference and consistency metadata |

The first full Electron run stopped on a WPF `snapshot_changed` while property events were being delivered. No rows from that generation were published. The fixture now reacquires only interrupted read-only observations marked `not_started`; it never repeats an action. The subsequent complete Electron run passed. GUI fixtures own their HWNDs/PIDs and run sequentially; existing application documents are not test targets. The same frozen native fixture also passed in ordinary Node 22.19 using the actual official Cordis local subprocess service and production ManagedRunner.

### Frozen capture cost

The final successful Electron run measured time from starting acquisition to the first frozen page, including any tool-level progress continuations. Output pages contain at most 333 rows; the owned source contains approximately ten thousand. A smaller query sample followed the controlled mutations and resize.

| Scope | Covered nodes | Returned rows in result | First frozen page ms | Tool calls | Instrumented native calls across capture/validation |
| --- | ---: | ---: | ---: | ---: | ---: |
| UIA full bounded fixture | 10,020 | 10,020 | 10,928 | 1 | 60,120 |
| MSAA full bounded fixture | 10,001 | 10,001 | 38,842 | 2 | 140,013 |
| UIA exact query on resized fixture | 167 | 1 | 170 | 1 | 1,000 |

MSAA returned an empty progress page before the default 30-second tool deadline, then continued the same capture to validation/sealing in a second call. These are ordered samples on a shared desktop, with the hash-compiled worker already cached, not latency distributions, cold-compiler measurements or universal application speedups. Instrumented worker calls count selected client operations, not hidden provider/OS work. Full-scope collection and rereading increase first-page cost; frozen continuations make no further acquisition calls. The historical 0.5.2 comparison below measures a 300-node **live** page and is not evidence of the new default's first-page speed.

### Guarantees and remaining work

A frozen result guarantees that all delivered pages use the same retained rows. Two matching bounded reads and event checks cannot prove that all source fields existed together at a single instant: generic UIA/MSAA provide no whole-tree transaction here, and unreported transient changes can evade that evidence. Source-wide atomicity remains unimplemented and would require a reliable provider transaction or versioned snapshot facility.

Each worker retains at most four captures/results, at most 20,000 covered nodes and 32 MB estimated retained data per capture, and 64 MB in total. These are retention accounting budgets, not exact CLR heap/RSS limits. Captures and sealed results each have an absolute 120-second lifetime; paging does not renew it. Pool eviction expires the affected continuations/references. Coverage reports partial when depth/node/retention budgets truncate the verified scope; complete coverage is distinct from source atomicity and does not materialize all virtualized items.

The current action, input, platform and rendering boundaries remain as described in [SECURITY.md](SECURITY.md). In particular, MSAA cannot distinguish every identical replacement generation; macOS/Linux native desktop evidence and individual special UIA patterns are still pending. This change does not supply task-success or SOTA-equivalence evidence.

### Reproduce 0.5.3

Run from the repository, selecting an actual Harness checkout through `DSH_HARNESS_ROOT` when it is not adjacent:

```powershell
pnpm run verify
pnpm run verify:profile
pnpm run smoke:snapshots
pnpm run smoke:electron "C:\path\to\DeepSeek Harness.exe"
pnpm run native:stage
pnpm pack --pack-destination .local
```

`prepack` repeats JavaScript verification and checks the staged native executable/source manifest against 0.5.3. The Rust sources and executable bytes are unchanged; executable SHA-256 remains `9a86acbb39edde4d36972c913fb5b5dd594e50a8e944386016e63bdd8b10b789`. Worker compilation includes the new [fixed-result implementation](src/windows-semantic-snapshot.cs) in its source hash and compiler input. No live deployment installation or host restart is part of this verification.

## Historical 0.5.2 validation — 2026-10-07

The 0.5.2 checks exercise scoped observation invalidation, reusable window identities, file-only capture and bounded Windows native acquisition. UIA/MSAA now use independent .NET Framework workers through the official Cordis local subprocess service and the production ManagedRunner. Narrator retains the optional runtime-matched in-process bridge. The historical sections below record earlier versions; their single-use window-ID rules, in-process UIA/MSAA limitation and absence of a performance comparison do not describe 0.5.2.

| Check | Result | What it establishes |
| --- | --- | --- |
| `pnpm run verify` | 53 JavaScript syntax checks; all 61 regression tests passed | Coordinate/configuration bounds, scoped invalidation and identity reuse, text-only semantics, AX/AT-SPI per-call budgets and rejection of unsupported shapes, real DSH ToolRuntime attachment/approval/file-output contracts |
| Worker lifecycle contracts | All four protocol tests passed | Queued timeout does not release its predecessor; action timeout waits for exit confirmation and expires references; unconfirmed termination prevents replacement; cancellation before startup sends no native request |
| `pnpm run verify:profile` | Temporary real Loader profile passed | Provider, all 18 tools and workflow prompt mounted; observation allow and explicit control deny worked; the isolated home was removed |
| Actual Electron 44.0.0, embedded Node 24.18.1 / ABI 149 | Bridge plus WPF, WinForms and large-tree suite passed | Runtime-matched Narrator bridge and 12 concurrent calls; actual semantic focus/set-value/toggle/invoke; 8 WPF document/selection/value/range/multiple-selection/invoke/identity checks; 5 independent MSAA tree/read/write/default-action/PID checks |
| Controlled native large trees | 10,020 UIA rows in 74 pages; 10,001 MSAA rows; 136 acquisition samples | Continuation without replay, deep and observed-root branches, children scope, native exact/contains queries, result/node/depth budgets, late reference action, offscreen invoke and explicit ItemContainer/VirtualizedItem operations |
| Native byte budget | Nonempty partial page and continuation under a 4,096-byte budget passed | Measured serialized rows include reference tokens, worker generation and parent IDs; the implementation also rejects an oversized first row rather than yielding a non-progress cursor |
| Native blocking and recovery | UIA/MSAA blocked reads and UIA blocked action passed | A 500ms deadline terminates the worker and confirms exit; a new owned fixture remains usable; an already-dispatched action reports unknown, is invoked once and is not automatically retried |

The final large-tree run after the depth-boundary continuation fix used the actual Electron executable, waited for process completion and passed the same native checks. An earlier successful run also used ordinary Node 22.19 with the real managed subprocess backend. GUI fixtures run sequentially and own their windows/processes; no existing application document is a test target.

MSAA optional string fields treat only explicit `DISP_E_MEMBERNOTFOUND` / `E_NOTIMPL` as unsupported. Value reads report `value_supported`, and absent description/help/default-action fields are omitted. Other COM failures propagate. Startup structure events can invalidate a read-only snapshot; the fixture may reacquire that observation, while production actions are never automatically retried.

### Measured acquisition work

The [controlled provider](test/windows-large-tree-fixture.cs) counts actual calls to GetPropertyValue, GetPatternProvider, Navigate and GetRuntimeId. Each sample resets those counters. The [large-tree test](test/win32-semantic-large-tree-smoke.mjs) compares the existing ConvertNode algorithm in a separate [baseline executable](test/windows-legacy-baseline.cs) with the new worker on the same UIA window, at 300 returned nodes and depth 6. The successful final run produced:

| Sample | Elapsed ms | Response bytes | Property reads | Pattern reads | Navigations | Runtime IDs |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Legacy, first acquisition | 1,409 | 117,284 | 4,998 | 6,468 | 884 | 1,175 |
| Legacy, subsequent acquisition | 811 | 117,284 | 4,998 | 6,468 | 884 | 1,175 |
| Worker, first acquisition | 504 | 178,093 | 4,124 | 5,310 | 885 | 879 |
| Worker, subsequent acquisition | 140 | 178,092 | 4,113 | 5,292 | 881 | 879 |
| Late Item 9999 invoke through its registered reference | 18 | — | 8 | 1 | 2 | 3 |

The worker's first acquisition reported queue/startup/total host time of 0/16/502ms; the subsequent acquisition reported 0/0/138ms. Outer elapsed time also includes conversion and test-wrapper work. The hash-compiled worker executable was already cached for this run. Compilation of the baseline executable occurs before these samples, and these numbers are not fresh-compiler or cold-machine measurements. Both first calls include their process's remaining CLR/UIA initialization and real provider cache state.

Property and pattern work decreased in this fixture. Response bytes increased about 52% because of native references, parent links, coverage and worker metadata. The late action did not replay a root-to-target scan or the old 5,000-candidate limit; UIA still performed the two measured internal navigations. These are ordered individual samples on a shared interactive desktop, not latency distributions or universal application speedups. Queue time was zero in this single-producer run; contention and termination behavior are checked separately by the lifecycle contracts. The worker's `native_calls` statistic counts selected instrumented client operations, not hidden provider/OS work; it is distinct from the fixture's counters above.

### Current limits

- Native traversal and queries remain bounded walks. Exact UIA conditions run in `TreeScope.Element` at each visited node; no constant-time whole-tree lookup or unbounded descendant materialization is claimed. Partial coverage, depth limits and uninstantiated virtual items cannot establish global absence.
- Structure events and bounded sibling anchors do not create an atomic multi-page snapshot or detect every unreported mutation. MSAA and HWND APIs cannot distinguish every same-property replacement generation.
- Terminating a worker does not undo an application effect or unblock the application's own provider thread. Recovery checks create another owned fixture when the blocked provider remains busy. Unknown actions are not retried.
- UIA grid and special Scroll/Window/Transform patterns still lack individual native acceptance assertions. WPF text selection changed foreground; semantic operations and child handlers can activate applications. There is no general foreground-preservation guarantee.
- macOS AX and Linux AT-SPI have budget/identity/provider contracts, but their native desktops, permissions and application action results remain untested. They do not implement these Windows native roots, children-only scope, persistent paging/query or worker isolation. macOS multi-monitor origin mapping remains pending.
- Narrator status/bridge and fixed-key contracts are tested. Its actual layout is unknown, and speech and virtual cursor movement are not observed. Input delivery does not verify either outcome.
- PrintWindow/integrity and forced input-helper termination limitations in [SECURITY.md](SECURITY.md) remain. No task corpus, completion rate, general recovery-rate comparison or SOTA-equivalence claim is established by these fixtures.

### Reproduce 0.5.2

Run from the repository with an actual Harness checkout selected by `DSH_HARNESS_ROOT` when it is not adjacent:

```powershell
pnpm run verify
pnpm run verify:profile
pnpm run smoke:semantics
pnpm run smoke:electron "C:\path\to\DeepSeek Harness.exe"
pnpm pack --pack-destination .local
```

`prepack` repeats JavaScript verification and checks the staged Rust executable and source hashes against version 0.5.2. The existing Rust sources and release bytes are unchanged; executable SHA-256 remains `9a86acbb39edde4d36972c913fb5b5dd594e50a8e944386016e63bdd8b10b789`. Windows worker C# sources are shipped and hash-compiled at runtime; no production Harness implementation dependency or deployment installation is added by this validation.

## Historical 0.5.1 validation

### Electron bridge repair — 2026-10-06

The installed 0.5.0 bundle's UIA, MSAA and Narrator tools still failed after a genuine desktop restart. Its `edge-js` loader selected the ordinary Node 24 prebuild in Electron 44.0.0 (embedded Node 24.18.1, ABI 149), producing `ERR_DLOPEN_FAILED`. Ordinary bundled Node 24.21.0 uses ABI 137 and loaded that dependency successfully. A dependency-present flag or ordinary Node test was insufficient to verify the desktop host.

0.5.1 selects `electron-edge-js` 44.0.0 for Electron and retains `edge-js` for ordinary Node. The compiler is resolved from the selected dependency scope, and relocation preserves both `edge-cs.dll` and `edge-cs-base.dll` in a content-addressed directory. Missing optional dependencies expose the runtime/ABI and original resolution error with a string error code and preserved cause.

Using the actual installed desktop executable with `ELECTRON_RUN_AS_NODE=1`, the permanent `smoke:electron` command passed on Electron 44.0.0 / ABI 149:

| Check | Measured result |
| --- | --- |
| Native bridge | Matching Electron binary loaded; compiler companion DLL present; Narrator status returned; 12 concurrent calls completed |
| WPF UIA | All 8 document/selection/value/range/multiple-selection/invoke/stale-identity checks passed |
| WinForms MSAA | All 5 tree/read/value-write/default-action/PID-rejection checks passed |
| Ordinary bundled Node 24.21.0 / ABI 137 | The same bridge, UIA and MSAA fixtures passed using `edge-js` |

The 0.5.1 release gate passed 49 JavaScript syntax checks, all 56 regression tests (including the real DSH ToolRuntime), and native artifact/source hash verification before packaging.

Dependencies were fetched with install scripts skipped. The tested Windows .NET Framework path does not need the dependency's CoreCLR SDK builds. Narrator reported not running in Windows session 1; these checks establish state querying, not speech or virtual-cursor behavior. Each fixture owned its PID/HWND and read resulting application state. UIA text selection changed foreground as in the earlier fixture; no blanket foreground-preservation guarantee is claimed.

These are native runtime fixture tests of the repaired package using the desktop executable. The running profile must be updated through the official plugin manager and reloaded before its live tools can be marked fixed. Other Electron versions are not established by this Electron 44 result.

## Historical 0.5.0 validation

All remaining sections below record 0.5.0, including its original implementation limits and reproduction commands. Current mechanisms and measured outcomes are documented above.

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

Native smoke tests own their WPF/WinForms processes and temporary scripts and clean them afterward. Production Windows code invokes no PowerShell: capture/input/window work uses the source-available Rust helper; UIA/MSAA/Narrator use the optional runtime-matched edge-js/electron-edge-js C# bridge compiled in-process.

During reruns, a fixture's foreground activation needed time to settle, and another Harness window changed desktop focus during a slow UIA read. The native smoke now checks foreground immediately after message delivery and waits for the owned cover's actual state before later assertions. Final staged-exe run passed all 10 checks. This is an interactive shared desktop, not an isolated benchmark machine.

## Historical 0.5.0 limits and pending native evidence

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
