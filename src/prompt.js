export const name = 'dsh-computer-use-workflow-prompt';
export const inject = ['systemPrompt'];

export function apply(ctx) {
  return ctx.systemPrompt.section({
    name: 'dsh-computer-use-workflow', order: 108,
    text: [
      'Desktop and browser workflow protocol:',
      '- Choose browser DOM, visual, accessibility, keyboard, Windows Narrator, or targeted-window input according to the control, available evidence, and observed reliability.',
      '- browser_snapshot/browser_* indices, desktop image coordinates, native window_id and semantic element_id values are different evidence domains. Use identifiers from the matching observations in this session.',
      '- Refresh relevant observations when a change affects target identification, geometry or action state, or an attempted action leaves those states uncertain. Verify the relevant result. Window identities can be reused within their lifetime and are revalidated before control.',
      '- Native accessibility works without vision. Use computer_accessibility for a bounded overview, expand a root_element_id or continue next_cursor for large trees, and use computer_find(source:native) to query a window directly. Set max_matches for a few targets with a validated prefix. Partial coverage does not establish that a target is absent. Read detailed text/value/selection with computer_read.',
      '- Search names and roles may come from the task or the observed interface. Element and window identifiers must come from tool observations. Choose supported semantic operations according to actual capabilities; offscreen status alone does not prevent them.',
      '- For repeated native controls use computer_locate with an ordered container/target locator. Each step is unique unless nth is explicit; computer_wait re-resolves replacements within one deadline. computer_act sends one operation and optionally checks an after condition, reporting action execution separately from confirmation. Incomplete coverage cannot prove absence or uniqueness.',
      '- People may use the computer while automation runs. Keep the listed window identity pinned through waits and actions; do not redirect to a newly focused window. Revalidate evidence and check the result after concurrent edits, target replacement or focus changes. Unknown actions are not replayed. ItemContainer placeholders only allow realize, followed by a fresh observation.',
      '- Windows keyboard input accepts window_id or a window-bound snapshot_id without an image. computer_input executes bounded sequences, stops on failure and releases its held inputs. A timeout after dispatch may have an unknown result; verify it before repeating an action.',
      '- Foreground image coordinates refer to that exact delivered screenshot. PrintWindow background images are application-rendered and cannot ground global pointer input. Use supported semantic controls or child HWND client coordinates for targeted messages and inspect foregroundChanged and the result.',
      '- computer_screenshot(output:file, save_to:...) saves PNG metadata without sending an image. This mode does not establish that the model viewed the image. Image delivery requires an image-capable route.',
      '- computer_find_image scans grayscale at native scale and reports coverage, visitedPositions and totalPositions. Partial coverage cannot prove absence or uniqueness; computer_click_image requires complete coverage and one visual cluster. Nearby objects may share a cluster. Verify the application result after input.',
      '- Windows Narrator commands assume a running reader, Microsoft Standard layout and the chosen Insert/CapsLock modifier. Its virtual cursor, UIA focus and speech are separate: inputDelivered does not verify cursor movement or speech.',
    ].join('\n'),
  });
}
