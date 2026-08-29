# dsh-computer-use

`dsh-computer-use` is an independent Cordis plugin suite that gives DeepSeek Harness a model-visible, audited desktop-computer capability without modifying the Harness source tree or any shipped agent preset.

The host bundle publishes one `computer` service. A user-owned preset separately mounts `dsh-computer-use/tool`, which contributes screenshot, pointer, keyboard, window, and accessibility tools to that preset's sessions only.

## Capability Model

- Screenshot observations return a PNG attachment and a short-lived screenshot ID.
- Coordinate operations must name that screenshot ID. The provider converts image pixels back to physical desktop coordinates using the capture bounds retained with the observation.
- Input actions are serialized and are exclusive tool calls. The next step should observe the screen again before taking another consequential action.
- Windows provides direct capture, pointer/keyboard injection, top-level window control, and a bounded UI Automation tree.
- macOS and Linux use capability detection. Full screen capture is implemented through system facilities; optional native input backends are advertised only when they are available.
- The provider does not use the system clipboard as an image transport and never imports Rubick's opaque `ScreenCapture.exe`.

## Install Into The Current Web Profile

From `D:\dev\deepseek-harness`:

```powershell
pnpm dsh plugin --profile web add D:\dev\dsh-computer-use
```

That installs the host bundle into the profile. The bundle stack is read when the Harness process starts, so restart the existing Harness through its normal restart control before starting a session with this capability; refreshing the browser page alone does not mount a newly installed host bundle.

Create or select a user-owned preset, then add this row to its `agent.cordis.yml`:

```yaml
- id: computer-use-tools
  name: dsh-computer-use/tool
  config:
    observeApproval: allow
    controlApproval: allow
    maxObservationAgeMs: 120000
    maxObservationsPerAgent: 8
```

`allow` is appropriate only for a session where the user intentionally delegates desktop control. The package defaults both modes to `ask` when omitted.

## Development

```powershell
npm run verify
```

The project has no runtime npm dependency. It uses the live Cordis services supplied by the host profile, so it remains an independently versioned project while DSH remains the composition host.

## Security

Read [SECURITY.md](SECURITY.md) before enabling control actions. It describes image retention, screenshot freshness, approval modes, platform-dependent capabilities, and the current preset's explicit delegated-control policy.

## Provenance

See [references/UPSTREAM.md](references/UPSTREAM.md). The project records the audited references and uses no third-party desktop-automation binary or direct npm driver dependency.
