// 标准控件协议的数据预算与结果合同。读取结果不提供语义 element_id 或点击坐标。
export const LISTVIEW_OPTIONS_SCHEMA = {
  columns: { type: 'array', minItems: 1, maxItems: 32, uniqueItems: true, items: { type: 'integer', minimum: 0, maximum: 255 }, description: 'Required zero-based column indices, returned in this order.' },
  start_row: { type: 'integer', minimum: 0, maximum: 2147483647, description: 'First zero-based row, default 0.' },
  max_rows: { type: 'integer', minimum: 1, maximum: 512, description: 'Maximum rows in this page, default 100.' },
  max_cells: { type: 'integer', minimum: 1, maximum: 4096, description: 'Maximum returned cells, default 1000.' },
  max_chars: { type: 'integer', minimum: 1, maximum: 262144, description: 'Total UTF-16 code-unit budget, default 32000.' },
  max_cell_chars: { type: 'integer', minimum: 1, maximum: 4000, description: 'Per-cell UTF-16 code-unit limit, default 1000. A capacity-bound cell is conservatively incomplete.' },
  timeout_ms: { type: 'integer', minimum: 1, maximum: 120000, description: 'Hard total deadline including helper startup, default 10000ms.' },
  message_timeout_ms: { type: 'integer', minimum: 1, maximum: 1000, description: 'Per-message ceiling within the total deadline, default 200ms.' },
};
function integer(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be ${min}..${max}`);
  return value;
}
export function listViewOptions(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('ListView options must be an object');
  if (!Array.isArray(raw.columns) || raw.columns.length < 1 || raw.columns.length > 32) throw new Error('columns must contain 1..32 indices');
  const columns = raw.columns.map(column => integer(column, 'column', 0, 255));
  if (new Set(columns).size !== columns.length) throw new Error('columns must be unique');
  return {
    columns, startRow: integer(raw.start_row ?? 0, 'start_row', 0, 2147483647),
    maxRows: integer(raw.max_rows ?? 100, 'max_rows', 1, 512),
    maxCells: integer(raw.max_cells ?? 1000, 'max_cells', 1, 4096),
    maxChars: integer(raw.max_chars ?? 32000, 'max_chars', 1, 262144),
    maxCellChars: integer(raw.max_cell_chars ?? 1000, 'max_cell_chars', 1, 4000),
    budgetMs: integer(raw.timeout_ms ?? 10000, 'timeout_ms', 1, 120000),
    messageTimeoutMs: integer(raw.message_timeout_ms ?? 200, 'message_timeout_ms', 1, 1000),
  };
}
const STOPS = new Set(['complete', 'row_limit', 'row_start', 'cell_limit', 'character_limit', 'cell_text_limit', 'source_count_changed', 'source_error']);
export function validateListViewResult(result, options) {
  const invalid = message => { throw new Error(`Invalid ListView result: ${message}`); };
  const bool = value => typeof value === 'boolean';
  const count = value => Number.isInteger(value) && value >= 0 && value <= 2147483647;
  if (!result || typeof result !== 'object' || result.source !== 'win32_listview_messages' || typeof result.className !== 'string'
      || !['complete', 'partial'].includes(result.coverage) || !STOPS.has(result.stopReason)) invalid('source/coverage');
  if (![null, 32, 64].includes(result.targetBits) || ![result.rowCount, result.columnCount, result.selectedCount].every(value => value === null || count(value))
      || !(result.focusedRow === null || (count(result.focusedRow) && result.rowCount !== null && result.focusedRow < result.rowCount))) invalid('metadata');
  if (result.selectedCount !== null && (result.rowCount === null || result.selectedCount > result.rowCount)) invalid('selection count');
  if (JSON.stringify(result.columns) !== JSON.stringify(options.columns) || result.startRow !== options.startRow
      || !Array.isArray(result.rows) || result.rows.length > options.maxRows) invalid('requested range');
  let cells = 0, chars = 0, completeRows = 0;
  result.rows.forEach((row, offset) => {
    if (!row || row.index !== options.startRow + offset || result.rowCount === null || row.index >= result.rowCount
        || !bool(row.selected) || !bool(row.focused) || !bool(row.complete) || !Array.isArray(row.cells)
        || row.cells.length > options.columns.length) invalid('row');
    row.cells.forEach((cell, columnOffset) => {
      if (!cell || cell.column !== options.columns[columnOffset] || typeof cell.text !== 'string' || !bool(cell.complete)
          || cell.text.length > options.maxCellChars || (cell.complete && cell.text.length >= options.maxCellChars)) invalid('cell');
      if (!cell.complete && (offset !== result.rows.length - 1 || columnOffset !== row.cells.length - 1)) invalid('incomplete cell is not last');
      cells += 1; chars += cell.text.length;
    });
    if (row.complete) {
      if (row.cells.length !== options.columns.length || row.cells.some(cell => !cell.complete) || completeRows !== offset) invalid('complete row');
      completeRows += 1;
    } else if (offset !== result.rows.length - 1) invalid('incomplete row is not last');
  });
  if (cells !== result.cellsRead || cells > options.maxCells || chars !== result.charsRead || chars > options.maxChars
      || result.nextRow !== options.startRow + completeRows) invalid('read prefix/counters');
  if (!bool(result.sourceCountChanged) || !bool(result.remoteBufferQuarantined) || !count(result.messages)
      || !Number.isFinite(result.elapsedMs) || result.elapsedMs < 0) invalid('diagnostics');
  if ((result.stopReason === 'source_error') !== (typeof result.error === 'string' && result.error.length > 0)
      || (result.stopReason !== 'source_error' && result.error !== null)) invalid('source error');
  if (![result.failedRow, result.failedColumn].every(value => value === null || count(value))) invalid('failure location');
  if (result.coverage === 'complete' && (result.stopReason !== 'complete' || result.startRow !== 0 || result.rowCount === null
      || completeRows !== result.rowCount || result.error !== null || result.sourceCountChanged || result.remoteBufferQuarantined)) invalid('complete coverage');
  if (result.stopReason === 'complete' && result.coverage !== 'complete') invalid('complete stop reason');
  return result;
}
