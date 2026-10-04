# Security and Operating Boundary

## Authority and approval

This bundle operates the active local desktop through registered `computer_*` calls. It exposes no remote-control listener, arbitrary Win32 message API, C# reflection entrypoint or script-execution tool. Runtime capabilities come from Cordis services; production code does not import Harness implementation packages.

Observation and control have independent `ask` / `allow` / `deny` policies. A local deny is enforced before downstream listeners and repeated in the final guard. Default ask inherits Full access only when the authoritative permission-presets service resolves both `danger-full-access` and `approval:never`; missing/unknown state remains ask. A pre-execution listener cannot silently bypass an ordinary local ask: the tool body requests approval before reaching the provider.

Window listing, child enumeration, accessibility snapshots, reading and Narrator status are observations. Foreground window capture, focus, input, semantic mutations, window management and Narrator commands are controls. Windows `background:true` PrintWindow capture is observation; the helper does not request focus or restore a minimized window.

## Evidence and identity

Observation IDs are isolated to the calling agent/session, bounded in memory and expire after `maxObservationAgeMs`. Native control attempts consume the calling agent's prior evidence, including when the provider reports an error after a possible side effect. Reading does not consume a snapshot.

Coordinate input requires a fresh foreground screenshot ID. Coordinates must lie within the persisted attachment, then map through the actual captured source bounds. Screenshot results hash the persisted attachment bytes after DSH normalization. A background PrintWindow image cannot authorize global pointer input.

Accessibility has an independent text-only path: focused application or, on Windows, a freshly listed target window. No image model is required. A snapshot optionally bound to a screenshot retains that exact screenshot ID and SHA-256; actions/read cannot replace it with a different fresh image. Semantic operations never fall back to a coordinate click.

UIA actions re-identify runtime ID/process/available identity fields within the finite action-candidate budget. MSAA uses root HWND/PID/title and a bounded accessible child path plus role/name/class; it has no provider runtime-generation guarantee. Child HWND messages additionally check parent/root/PID/class/title. Handle/path reuse with identical properties can remain indistinguishable in these legacy APIs. macOS and Linux check their observed paths/process/identity fields; native proof for those adapters remains pending.

## Input and failure handling

Windows translates public input into native sequences. All steps are validated before any focus/input side effects: <=256 steps, <=10 seconds total explicit hold/wait and bounded text. Unknown keys, invalid coordinates/durations and unbalanced duplicate downs fail validation. Input acquired by a sequence is released during normal completion or handled failure through RAII; keys/buttons already held externally are refused. Bound-window sequences check identity and foreground before each step and stop at the first error. Focus loss inside one already-running key/Unicode operation cannot roll back delivered events.

**Forced process termination, crashes or power loss do not guarantee RAII cleanup.** DSH cancellation/deadline enforcement may terminate the helper before its destructors run; held input cleanup is not promised for that case. Sequences are bounded to reduce exposure and tools discard old evidence after a control attempt. Applications determine shortcut semantics; input delivery is not application-result verification.

Subprocess operations use DSH's managed process service, a configured deadline, bounded output and cancellation. PrintWindow itself is synchronous; a hung application's rendering is bounded externally by the managed command deadline, not by a Win32 PrintWindow timeout. Fixed child messages use `SendMessageTimeoutW` (500ms each); a partial click still attempts button-up to the same checked target. The application may activate itself or trigger other behavior in a message handler; responses report `foregroundChanged`, `delivered` and `applicationResultVerified:false`. Close requests are not proof that an application closed.

Windows UIA/MSAA/Narrator status run through optional edge-js in-process C# bridges. Cancellation cannot preempt an arbitrary hanging in-process COM provider call; traversal/serialization budgets limit work but are not a universal COM-call timeout. This is a separate limitation from the managed native subprocess deadline.

## Capture and platform boundaries

Screenshots use the open-source bundled Rust/GDI helper on Windows, not the clipboard or an opaque capture utility. PrintWindow explicitly rejects minimized windows and never silently substitutes foreground capture. GPU/protected/non-cooperating applications may return failure or blank pixels even when the API reports success. Windows integrity/UIPI and target privileges constrain capture/input/messages; an exe with a Low file-integrity label may start Low and fail against a Medium target (observed Win32 error 5). The plugin does not elevate, repair labels or silently relocate binaries. Explicit `nativeHelperPath` overrides must exist and are not replaced by fallback probes.

macOS/Linux support desktop capture and basic input; region/window capture, background HWND APIs, atomic sequences and extended hold/repeat/path options fail explicitly. macOS AX requires Accessibility/Automation; Linux input/window control requires X11-compatible xdotool and semantics require Python/pyatspi/AT-SPI. Linux bounded text reads and macOS AX value/selected-text reads redact password contents. macOS/Linux runtime validation and macOS multi-monitor origin mapping remain pending.

## Narrator and sensitive content

Narrator status queries only processes in the current Windows login session. Commands require a running reader and fresh window-bound evidence, assume Microsoft Standard layout and use the explicitly selected Insert/CapsLock modifier. No reader is launched and no settings are changed. Narrator virtual cursor, speech and UIA keyboard focus are independent: this release does not capture speech or observe the virtual cursor, and command results mark those outcomes unverified.

Desktop screenshots and accessibility text can contain credentials or personal information. Image attachments and tool text may be supplied to the selected model route. Password redaction in semantic reading does not remove secrets already visible in a screenshot or exposed by a defective application provider.
