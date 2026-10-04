export const name = 'dsh-computer-use-workflow-prompt';
export const inject = ['systemPrompt'];

export function apply(ctx) {
  return ctx.systemPrompt.section({
    name: 'dsh-computer-use-workflow',
    order: 108,
    text: [
      'Desktop and browser workflow protocol:',
      '- Use browser_snapshot and browser_* tools for a browser tab when the bridge is connected; use computer_screenshot, computer_accessibility, computer_find, and computer_element for native desktop applications.',
      '- Browser snapshot indices, desktop screenshot coordinates, and native semantic element_id values belong to different evidence domains. Never reuse an identifier from one domain in another.',
      '- When a task crosses browser and desktop surfaces, first obtain fresh evidence from the surface you are about to control. After any consequential action, obtain fresh evidence before the next action.',
      '- Prefer browser DOM/interactive evidence for web controls and native semantic controls for desktop controls. Use coordinates only when semantic evidence is unavailable. Focus a native window only with a fresh computer_windows:list window_id from this agent session.',
      '- Native accessibility is an independent text path: computer_accessibility can observe the focused application or a listed Windows window without a screenshot; use computer_read for text/value/selection and computer_element for supported patterns. Explicit backend:msaa selects the separate Windows legacy API. A screenshot-bound snapshot retains its exact image binding.',
      '- Windows computer_key and computer_type can use a recent window_id or window-bound snapshot_id without vision. Use computer_input for bounded down/move/up or hold sequences; it stops on the first error and releases acquired inputs during normal completion or handled failure. Observe again after any control attempt, including failures.',
      '- A Windows background:true PrintWindow image is application-rendered and cannot ground global pointer actions. Use semantic controls or a fresh child HWND directory with computer_window_input; an application may activate itself after a targeted message, so inspect foregroundChanged and then read the result.',
      '- Windows Narrator commands assume Microsoft Standard layout and a running reader with the chosen Insert/CapsLock modifier. Narrator virtual cursor, UIA keyboard focus and speech are separate; inputDelivered does not verify cursor movement or speech. Do not infer them from a UIA snapshot.',
      '- Keep browser and desktop steps in one task narrative, but report the evidence identifier and the surface used for each consequential action.',
    ].join('\n'),
  });
}
