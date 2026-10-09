// 标准 ListView 的只读入口：只接受本会话 child HWND 目录里的短期身份。
import { randomUUID } from 'node:crypto';
import { LISTVIEW_OPTIONS_SCHEMA, listViewOptions } from './listview.js';
export function registerControlTools({ register, textTool, provider, child }) {
  register(textTool('computer_read_control',
    'Read standard Windows SysListView32/WinForms ListView specified columns, bounded rows, selection and focus via fixed read-only messages. Requires a recent child_window_id from computer_windows(operation:children). Returns read ranges, complete/partial coverage and source errors explicitly; no focus, selection or input. Owner-data/custom classes are unsupported. An unconfirmed pointer message or killed helper quarantines one fixed 8192-byte buffer per target process; further allocations are refused until that target exits.',
    { type: 'object', additionalProperties: false, required: ['child_window_id', 'columns'], properties: {
      child_window_id: { type: 'string' }, ...LISTVIEW_OPTIONS_SCHEMA,
    } }, async (raw, exec) => {
      const options = listViewOptions(raw);
      if (typeof raw.child_window_id !== 'string' || raw.child_window_id.length === 0) throw new Error('child_window_id must be non-empty');
      const observed = child(raw.child_window_id, exec), driver = provider();
      if (driver.capabilities.standardListView !== true || typeof driver.readListView !== 'function') throw new Error('standard ListView content reading is unsupported on this backend');
      const result = await driver.readListView(observed.list.root.nativeWindow, observed.child.nativeWindow, options, exec.signal);
      return JSON.stringify({ ...result, control_read_id: `control-read-${randomUUID()}`, observed_at: new Date().toISOString(),
        observation_domain: 'native_standard_control', child_window_id: raw.child_window_id,
      });
    }));
}
