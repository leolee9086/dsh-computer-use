function finiteBounds(raw) {
  if (raw === null || typeof raw !== 'object'
    || !Number.isFinite(raw.x) || !Number.isFinite(raw.y)
    || !Number.isFinite(raw.width) || !Number.isFinite(raw.height)
    || raw.width < 1 || raw.height < 1) {
    return undefined;
  }
  return {
    x: raw.x,
    y: raw.y,
    width: raw.width,
    height: raw.height,
  };
}

function stringValue(raw) {
  return typeof raw === 'string' ? raw : '';
}

function patternNames(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((value) => typeof value === 'string' && value.length > 0);
}

function modelElement(raw) {
  const elementId = stringValue(raw.element_id);
  if (elementId.length === 0) return undefined;
  const element = {
    element_id: elementId,
    role: stringValue(raw.role),
    name: stringValue(raw.name),
    automation_id: stringValue(raw.automation_id),
    class_name: stringValue(raw.class_name),
    enabled: raw.enabled !== false,
    focused: raw.focused === true,
    focusable: raw.focusable === true,
    offscreen: raw.offscreen === true,
    patterns: patternNames(raw.patterns),
  };
  if (Number.isInteger(raw.process_id) && raw.process_id > 0) element.process_id = raw.process_id;
  const processPath = stringValue(raw.process_path);
  if (processPath.length > 0) element.process_path = processPath;
  const bounds = finiteBounds(raw.bounds);
  if (bounds !== undefined) element.bounds = bounds;
  return element;
}

/** Flatten a native accessibility tree into model-safe actionable element rows. */
export function flattenAccessibilityTree(tree) {
  if (tree === null || typeof tree !== 'object') return [];
  const seen = new Set();
  const result = [];
  const pending = [tree];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== 'object') continue;
    const element = modelElement(current);
    if (element !== undefined && !seen.has(element.element_id)) {
      seen.add(element.element_id);
      result.push(element);
    }
    if (Array.isArray(current.children)) {
      for (let index = current.children.length - 1; index >= 0; index -= 1) pending.push(current.children[index]);
    }
  }
  return result;
}

function normalized(value) {
  return value.toLocaleLowerCase();
}

function matches(value, expected, mode) {
  if (expected === undefined) return true;
  const candidate = normalized(value);
  const query = normalized(expected);
  return mode === 'exact' ? candidate === query : candidate.includes(query);
}

/** Locate accessible elements by visible native semantics rather than pixels alone. */
export function findAccessibilityElements(tree, rawQuery, maxResults) {
  if (rawQuery === null || typeof rawQuery !== 'object' || Array.isArray(rawQuery)) {
    throw new Error('accessibility query must be an object');
  }
  const query = {
    name: rawQuery.name,
    role: rawQuery.role,
    automationId: rawQuery.automationId,
    match: rawQuery.match ?? 'contains',
    includeOffscreen: rawQuery.includeOffscreen === true,
  };
  for (const [key, value] of Object.entries({ name: query.name, role: query.role, automation_id: query.automationId })) {
    if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
      throw new Error(`${key} must be a non-empty string`);
    }
  }
  if (query.name === undefined && query.role === undefined && query.automationId === undefined) {
    throw new Error('accessibility query requires name, role, or automation_id');
  }
  if (!['exact', 'contains'].includes(query.match)) throw new Error('match must be exact or contains');
  if (!Number.isInteger(maxResults) || maxResults < 1) throw new Error('maxResults must be a positive integer');

  return flattenAccessibilityTree(tree).filter((element) => (
    (query.includeOffscreen || !element.offscreen)
    && element.enabled
    && matches(element.name, query.name, query.match)
    && matches(element.role, query.role, query.match)
    && matches(element.automation_id, query.automationId, query.match)
  )).slice(0, maxResults);
}

/** Find one actionable element by the opaque id returned from a semantic snapshot. */
export function accessibilityElementById(tree, elementId) {
  if (typeof elementId !== 'string' || elementId.length === 0) throw new Error('element_id must be a non-empty string');
  return flattenAccessibilityTree(tree).find((element) => element.element_id === elementId);
}
