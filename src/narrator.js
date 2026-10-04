// 微软 Standard 布局的有限命令表。讲述人虚拟光标与 UIA 键盘焦点各自独立。
// 不读取/改变讲述人配置；调用者明确选择其当前使用的 modifier。
export const NARRATOR_COMMANDS = Object.freeze({
  next_item: { key: 'right', modifiers: [] },
  previous_item: { key: 'left', modifiers: [] },
  next_view: { key: 'pagedown', modifiers: [] },
  previous_view: { key: 'pageup', modifiers: [] },
  read_current: { key: 'tab', modifiers: [] },
  read_window: { key: 'w', modifiers: [] },
  read_from_cursor: { key: 'r', modifiers: [] },
  read_title: { key: 't', modifiers: [] },
  read_document: { key: 'c', modifiers: [] },
  start_reading_document: { key: 'r', modifiers: ['control'] },
  read_selection: { key: 'down', modifiers: ['shift'] },
  read_current_line: { key: 'i', modifiers: [] },
  read_next_line: { key: 'o', modifiers: [] },
  read_previous_line: { key: 'u', modifiers: [] },
  read_current_word: { key: 'k', modifiers: [] },
  read_next_word: { key: 'l', modifiers: [] },
  read_previous_word: { key: 'j', modifiers: [] },
  repeat_last_speech: { key: 'x', modifiers: [] },
  toggle_scan: { key: 'space', modifiers: [] },
  activate: { key: 'enter', modifiers: [] },
  stop_speech: { key: 'control', modifiers: [], standalone: true },
});
export function narratorAction(command, modifier = 'insert') {
  const binding = Object.hasOwn(NARRATOR_COMMANDS, command) ? NARRATOR_COMMANDS[command] : undefined;
  if (binding === undefined) throw new Error(`unsupported Narrator Standard command '${command}'`);
  if (!['insert', 'capslock'].includes(modifier)) throw new Error('Narrator modifier must be insert or capslock');
  return { kind: 'key', key: binding.key, modifiers: binding.standalone ? [] : [modifier, ...binding.modifiers], repeat: 1, holdMs: 0 };
}
