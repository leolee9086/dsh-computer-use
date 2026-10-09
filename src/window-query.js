// 新根查询固定于已观测原窗口。owned 是真实 owner 链；线程/进程范围要显式选择。
export const WINDOW_QUERY_SCHEMA = {
  type: 'object', additionalProperties: false, properties: {
    relation: { type: 'string', enum: ['owned', 'same_thread', 'same_process'], description: 'Default owned follows the actual HWND owner chain. Thread/process correlation does not prove ownership.' },
    title: { type: 'string', maxLength: 1024, description: 'Exact title, including an explicit empty title for menus/popups.' },
    class_name: { type: 'string', minLength: 1, maxLength: 512, description: 'Exact native window class.' },
    max_windows: { type: 'integer', minimum: 1, maximum: 4096, description: 'Bound on inspected top-level HWNDs, default 1024. A partial scan cannot prove absence or uniqueness.' },
  },
};
export function windowQueryOptions(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('window_query must be an object');
  for (const key of Object.keys(raw)) if (!Object.hasOwn(WINDOW_QUERY_SCHEMA.properties, key)) throw new Error(`unsupported window query field '${key}'`);
  const relation = raw.relation ?? 'owned', maxNodes = raw.max_windows ?? 1024;
  if (!['owned', 'same_thread', 'same_process'].includes(relation)) throw new Error('invalid window relation');
  if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > 4096) throw new Error('max_windows must be 1..4096');
  const result = { relation, maxNodes };
  if (raw.title !== undefined) {
    if (typeof raw.title !== 'string' || raw.title.length > 1024) throw new Error('window title must contain at most 1024 characters');
    result.title = raw.title;
  }
  if (raw.class_name !== undefined) {
    if (typeof raw.class_name !== 'string' || raw.class_name.length < 1 || raw.class_name.length > 512) throw new Error('window class_name must contain 1..512 characters');
    result.className = raw.class_name;
  }
  return result;
}
export function validateRelatedWindows(result, target, options) {
  const bad = message => { throw new Error(`Invalid related-window result: ${message}`); };
  const handle = value => typeof value === 'string' && /^-?\d+$/.test(value) && value !== '0';
  if (!result || result.source !== 'win32_related_windows' || result.anchorId !== target.id || result.relation !== options.relation
      || !['complete', 'partial'].includes(result.coverage) || !['complete', 'node_budget', 'time_budget'].includes(result.stopReason)
      || (result.coverage === 'complete') !== (result.stopReason === 'complete')
      || !Number.isInteger(result.visited) || result.visited < 0 || result.visited > options.maxNodes
      || !Array.isArray(result.windows) || result.windows.length > result.visited) bad('scope/coverage');
  const seen = new Set();
  for (const row of result.windows) {
    if (!row || !handle(row.id) || row.id === target.id || seen.has(row.id) || typeof row.title !== 'string'
        || !Number.isInteger(row.processId) || row.processId < 1 || !Number.isInteger(row.threadId) || row.threadId < 1
        || typeof row.className !== 'string' || !row.className || !Array.isArray(row.ownerChain) || row.ownerChain.length > 32
        || !row.ownerChain.every(handle) || new Set(row.ownerChain).size !== row.ownerChain.length
        || row.ownerChain.includes(row.id) || row.ownerId !== (row.ownerChain[0] ?? null)
        || !row.bounds || !['x', 'y', 'width', 'height'].every(key => Number.isInteger(row.bounds[key])) || row.bounds.width < 1 || row.bounds.height < 1
        || typeof row.focused !== 'boolean' || typeof row.minimized !== 'boolean') bad('window identity/owner');
    seen.add(row.id);
    if ((options.title !== undefined && row.title !== options.title) || (options.className !== undefined && row.className !== options.className)
        || (options.relation === 'owned' && !row.ownerChain.includes(target.id))
        || (options.relation === 'same_process' && row.processId !== target.processId)
        || (options.relation === 'same_thread' && row.threadId !== target.threadId)) bad('requested relation/filter');
  }
  return result;
}
