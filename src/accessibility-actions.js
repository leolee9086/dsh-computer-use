// 语义操作合同集中在这里：工具与 provider 共享名称，避免模式名字和实参漂移。
export const PATTERN_BY_OPERATION = Object.freeze({
  invoke: 'invoke', focus: undefined, set_value: 'value', toggle: 'toggle',
  expand: 'expand_collapse', collapse: 'expand_collapse', select: 'selection_item',
  scroll_into_view: 'scroll_item', add_to_selection: 'selection_item', remove_from_selection: 'selection_item',
  set_range: 'range_value', scroll: 'scroll', set_scroll: 'scroll',
  select_text: 'text', scroll_text: 'text', window_state: 'window', close: 'window',
  move: 'transform', resize: 'transform', realize: 'virtualized_item', find_item: 'item_container',
});
export const ELEMENT_OPERATIONS = Object.keys(PATTERN_BY_OPERATION);
export const SEMANTIC_PARAMETERS = Object.freeze({
  value: { type: 'string' }, number: { type: 'number' },
  property: { type: 'string', enum: ['name', 'automation_id'], description: 'find_item: exact container lookup property (default name). May instantiate or scroll an item.' },
  horizontal: { type: ['number', 'string'] }, vertical: { type: ['number', 'string'] },
  text: { type: 'string' }, start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 0 },
  state: { type: 'string', enum: ['Normal', 'Minimized', 'Maximized'] },
  x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number', minimum: 1 }, height: { type: 'number', minimum: 1 },
});
const SCROLL_AMOUNTS = ['NoAmount', 'SmallIncrement', 'SmallDecrement', 'LargeIncrement', 'LargeDecrement'];

export function textRangeArgs(args) {
  if (args.text !== undefined) {
    if (typeof args.text !== 'string' || args.text.length === 0) throw new Error('text must be a non-empty string');
    if (args.start !== undefined || args.end !== undefined) throw new Error('use text or start/end, not both');
    return { text: args.text };
  }
  if (args.start === undefined && args.end === undefined) return {};
  if (!Number.isInteger(args.start) || !Number.isInteger(args.end) || args.start < 0 || args.end < args.start || args.end > 1_000_000) throw new Error('start/end must be an ordered non-negative character range within 1000000');
  return { start: args.start, end: args.end };
}

export function semanticActionArgs(operation, args) {
  const result = {};
  const number = (key, minimum = -Infinity, maximum = Infinity) => {
    if (!Number.isFinite(args[key]) || args[key] < minimum || args[key] > maximum) throw new Error(`${key} must be finite and between ${minimum} and ${maximum}`);
    result[key] = args[key];
  };
  switch (operation) {
    case 'find_item':
      if (typeof args.value !== 'string' || args.value.length === 0) throw new Error('find_item requires a non-empty value');
      result.property = args.property ?? 'name';
      if (!['name', 'automation_id'].includes(result.property)) throw new Error('find_item property must be name or automation_id');
      result.value = args.value; break;
    case 'set_value':
      if (typeof args.value !== 'string') throw new Error('value must be a string for set_value');
      result.value = args.value; break;
    case 'set_range': number('number'); break;
    case 'move': number('x'); number('y'); break;
    case 'resize': number('width', 1); number('height', 1); break;
    case 'set_scroll': number('horizontal', -1, 100); number('vertical', -1, 100); break;
    case 'scroll':
      for (const key of ['horizontal', 'vertical']) {
        result[key] = args[key] ?? 'NoAmount';
        if (!SCROLL_AMOUNTS.includes(result[key])) throw new Error(`${key} must be ${SCROLL_AMOUNTS.join(', ')}`);
      }
      if (result.horizontal === 'NoAmount' && result.vertical === 'NoAmount') throw new Error('scroll must move at least one axis');
      break;
    case 'window_state':
      if (!['Normal', 'Minimized', 'Maximized'].includes(args.state)) throw new Error('state must be Normal, Minimized or Maximized');
      result.state = args.state; break;
    case 'select_text': case 'scroll_text': Object.assign(result, textRangeArgs(args)); break;
    default: break;
  }
  for (const key of Object.keys(SEMANTIC_PARAMETERS)) {
    if (args[key] !== undefined && !(key in result) && args[key] !== '') throw new Error(`${key} is not valid for ${operation}`);
  }
  return result;
}
