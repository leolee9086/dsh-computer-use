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
      '- Keep browser and desktop steps in one task narrative, but report the evidence identifier and the surface used for each consequential action.',
    ].join('\n'),
  });
}
