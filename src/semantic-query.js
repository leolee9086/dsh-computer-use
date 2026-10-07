// 查询、子树与分页的参数合同。分页预算有限，改变查询必须创建新的游标。
export const SEMANTIC_ACQUISITION_SCHEMA = Object.freeze({
  snapshot_id: { type: 'string', description: 'Snapshot containing root_element_id, or the previous page for cursor.' },
  root_element_id: { type: 'string', description: 'Expand this observed branch; requires snapshot_id.' },
  scope: { type: 'string', enum: ['children', 'subtree'] },
  detail: { type: 'string', enum: ['summary'] },
  max_nodes: { type: 'integer', minimum: 1, maximum: 20000 },
  max_depth: { type: 'integer', minimum: 0, maximum: 128 },
  timeout_ms: { type: 'integer', minimum: 100, maximum: 120000 },
  cursor: { type: 'string', description: 'next_cursor from a page. Continue with its snapshot_id; structure changes expire it.' },
});

export function acquisitionArgs(args) {
  const result = {};
  for (const [key, name, min, max] of [
    ['max_nodes', 'maxNodes', 1, 20000], ['max_depth', 'maxDepth', 0, 128], ['timeout_ms', 'timeoutMs', 100, 120000],
  ]) {
    if (args[key] !== undefined) {
      if (!Number.isInteger(args[key]) || args[key] < min || args[key] > max) throw new Error(`${key} must be ${min}..${max}`);
      result[name] = args[key];
    }
  }
  if (args.scope !== undefined) {
    if (!['children', 'subtree'].includes(args.scope)) throw new Error('scope must be children or subtree');
    result.scope = args.scope;
  }
  if (args.detail !== undefined && args.detail !== 'summary') throw new Error('detail must be summary; use computer_read for detailed state');
  if (args.detail !== undefined) result.detail = args.detail;
  return result;
}

// AX/AT-SPI 的现有一次性桥支持焦点树和逐次预算；尚无可持续引用游标。
// 请求它们不支持的获取形态要明确报错，不能静默忽略这些参数。
export function basicAcquisitionOptions(options, config, platform) {
  if (options.root !== undefined || options.cursor !== undefined || options.query !== undefined || (options.scope !== undefined && options.scope !== 'subtree')) {
    throw new Error(`${platform} native subtree roots, children-only scope, paging and native queries are unsupported`);
  }
  const args = acquisitionArgs({ max_nodes: options.maxNodes, max_depth: options.maxDepth, timeout_ms: options.timeoutMs, detail: options.detail });
  return { maxNodes: args.maxNodes ?? config.maxAccessibilityNodes, maxDepth: args.maxDepth ?? config.maxAccessibilityDepth,
    timeoutMs: args.timeoutMs ?? config.commandTimeoutMs };
}

export function queryArgs(args) {
  const query = { match: args.match ?? 'contains', includeOffscreen: args.include_offscreen === true };
  if (args.include_offscreen !== undefined && typeof args.include_offscreen !== 'boolean') throw new Error('include_offscreen must be boolean');
  if (!['exact', 'contains'].includes(query.match)) throw new Error('match must be exact or contains');
  for (const [key, name] of [['name', 'name'], ['role', 'role'], ['automation_id', 'automationId']]) {
    if (args[key] !== undefined && args[key] !== '') {
      if (typeof args[key] !== 'string') throw new Error(`${key} must be a string`);
      query[name] = args[key];
    }
  }
  if (query.name === undefined && query.role === undefined && query.automationId === undefined) throw new Error('query requires name, role, or automation_id');
  return query;
}
