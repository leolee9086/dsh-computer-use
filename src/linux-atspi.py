#!/usr/bin/env python3
"""Bounded AT-SPI bridge for dsh-computer-use.

The Node provider passes one base64 JSON payload. This helper deliberately uses
only pyatspi plus the Python standard library so it can run on common GNOME and
other AT-SPI desktops without a Node native module.
"""

import base64
import json
import os
import sys

try:
    import pyatspi
except Exception as error:
    raise RuntimeError(
        "Linux accessibility requires python3 with pyatspi and an active AT-SPI bus"
    ) from error


def safe(call, fallback):
    try:
        return call()
    except Exception:
        return fallback


def children_of(accessible, limit):
    count = safe(lambda: int(accessible.childCount), 0)
    allowed = min(max(0, count), max(0, limit))
    for index in range(allowed):
        child = safe(lambda index=index: accessible.getChildAtIndex(index), None)
        if child is not None:
            yield index, child


def state_contains(accessible, constant_name):
    constant = getattr(pyatspi, constant_name, None)
    if constant is None:
        return False
    return bool(safe(lambda: accessible.getState().contains(constant), False))


def attributes_of(accessible):
    attributes = {}
    for entry in safe(lambda: accessible.getAttributes(), []):
        if not isinstance(entry, str) or ":" not in entry:
            continue
        key, value = entry.split(":", 1)
        attributes.setdefault(key.strip().lower(), value)
    return attributes


def process_id_of(accessible):
    value = safe(lambda: int(accessible.get_process_id()), 0)
    if value > 0:
        return value
    application = safe(lambda: accessible.get_application(), None)
    return safe(lambda: int(application.get_process_id()), 0) if application else 0


def process_path_of(accessible):
    process_id = process_id_of(accessible)
    if process_id < 1:
        return ""
    try:
        return os.readlink(f"/proc/{process_id}/exe")
    except OSError:
        return ""


def component_bounds(accessible):
    component = safe(lambda: accessible.queryComponent(), None)
    if component is None:
        return None
    rect = safe(lambda: component.getExtents(pyatspi.DESKTOP_COORDS), None)
    if rect is None:
        return None
    x = safe(lambda: int(rect.x), None)
    y = safe(lambda: int(rect.y), None)
    width = safe(lambda: int(rect.width), None)
    height = safe(lambda: int(rect.height), None)
    if None in (x, y, width, height) or width < 1 or height < 1:
        return None
    return {"x": x, "y": y, "width": width, "height": height}


def action_names(accessible):
    action = safe(lambda: accessible.queryAction(), None)
    if action is None:
        return []
    names = []
    count = safe(lambda: int(action.nActions), 0)
    for index in range(max(0, count)):
        name = safe(lambda index=index: action.getName(index), "")
        if isinstance(name, str) and name:
            names.append(name.lower())
    return names


def supports_interface(accessible, query_name):
    return safe(lambda: getattr(accessible, query_name)(), None) is not None


def patterns_of(accessible):
    actions = action_names(accessible)
    patterns = []
    if any(name in {"click", "press", "activate", "invoke", "open"} for name in actions):
        patterns.append("invoke")
    if "toggle" in actions:
        patterns.append("toggle")
    if "expand" in actions or "collapse" in actions or "expand or contract" in actions:
        patterns.append("expand_collapse")
    if "select" in actions:
        patterns.append("selection_item")
    if safe(lambda: accessible.queryComponent(), None) is not None:
        patterns.append("scroll_item")
    if supports_interface(accessible, "queryEditableText") or supports_interface(accessible, "queryValue"):
        patterns.append("value")
    return patterns


def node_id(path):
    return "atspi:" + ",".join(str(index) for index in path)


def accessible_node(accessible, path, depth, max_nodes, max_depth, budget):
    if budget[0] >= max_nodes:
        return None
    budget[0] += 1
    attributes = attributes_of(accessible)
    process_id = process_id_of(accessible)
    process_path = process_path_of(accessible)
    role = str(safe(lambda: accessible.getRoleName(), ""))
    name = str(safe(lambda: accessible.name, ""))
    node = {
        "element_id": node_id(path),
        "role": role,
        "name": name,
        "automation_id": attributes.get("id", attributes.get("automation-id", "")),
        "class_name": attributes.get("class", attributes.get("class-name", "")),
        "enabled": state_contains(accessible, "STATE_ENABLED"),
        "focused": state_contains(accessible, "STATE_FOCUSED"),
        "focusable": state_contains(accessible, "STATE_FOCUSABLE"),
        "offscreen": not (
            state_contains(accessible, "STATE_SHOWING")
            and state_contains(accessible, "STATE_VISIBLE")
        ),
        "patterns": patterns_of(accessible),
        "children": [],
    }
    if process_id > 0:
        node["process_id"] = process_id
    if process_path:
        node["process_path"] = process_path
    bounds = component_bounds(accessible)
    if bounds is not None:
        node["bounds"] = bounds
    if depth >= max_depth:
        return node
    for index, child in children_of(accessible, max_nodes - budget[0]):
        if budget[0] >= max_nodes:
            break
        child_node = accessible_node(
            child, path + [index], depth + 1, max_nodes, max_depth, budget
        )
        if child_node is not None:
            node["children"].append(child_node)
    return node


def find_focused_path(desktop, max_candidates):
    pending = [(desktop, [])]
    visited = 0
    while pending and visited < max_candidates:
        current, path = pending.pop()
        visited += 1
        if path and state_contains(current, "STATE_FOCUSED"):
            return path
        remaining = max(0, max_candidates - visited - len(pending))
        for index, child in reversed(list(children_of(current, remaining))):
            pending.append((child, path + [index]))
    return None


def active_application_path(desktop, max_candidates):
    focused = find_focused_path(desktop, max_candidates)
    if focused:
        return [focused[0]]
    for index, child in children_of(desktop, max_candidates):
        if process_id_of(child) > 0:
            return [index]
    raise RuntimeError("AT-SPI desktop contains no accessible application")


def resolve_path(desktop, path):
    current = desktop
    for index in path:
        if not isinstance(index, int) or index < 0:
            raise RuntimeError("AT-SPI element path is invalid")
        current = current.getChildAtIndex(index)
    return current


def parse_element_id(element_id, max_depth):
    if not isinstance(element_id, str) or not element_id.startswith("atspi:"):
        raise RuntimeError("AT-SPI element id is invalid")
    values = element_id[6:].split(",")
    if not values or any(not value.isdigit() for value in values):
        raise RuntimeError("AT-SPI element id is invalid")
    if len(values) - 1 > max_depth:
        raise RuntimeError("AT-SPI element path exceeds the configured snapshot depth")
    return [int(value) for value in values]


def verify_identity(accessible, expected):
    if process_id_of(accessible) != expected["processId"]:
        raise RuntimeError("AT-SPI element process changed after observation")
    attributes = attributes_of(accessible)
    actual = {
        "automationId": attributes.get("id", attributes.get("automation-id", "")),
        "name": str(safe(lambda: accessible.name, "")),
        "className": attributes.get("class", attributes.get("class-name", "")),
        "role": str(safe(lambda: accessible.getRoleName(), "")),
        "processPath": process_path_of(accessible),
    }
    for key, value in expected.items():
        if key == "processId" or not isinstance(value, str) or value == "":
            continue
        if actual.get(key, "") != value:
            raise RuntimeError("AT-SPI element " + key + " changed after observation")


def perform_named_action(accessible, names):
    action = safe(lambda: accessible.queryAction(), None)
    if action is None:
        raise RuntimeError("AT-SPI element has no action interface")
    count = safe(lambda: int(action.nActions), 0)
    for index in range(max(0, count)):
        name = str(safe(lambda index=index: action.getName(index), "")).lower()
        if name in names:
            if action.doAction(index):
                return
            raise RuntimeError("AT-SPI action reported failure")
    raise RuntimeError("AT-SPI element does not expose the required action")


def expand_or_collapse(accessible, expanded):
    current = state_contains(accessible, "STATE_EXPANDED")
    if current == expanded:
        return
    perform_named_action(accessible, {"expand", "collapse", "expand or contract"})


def set_value(accessible, value):
    editable = safe(lambda: accessible.queryEditableText(), None)
    if editable is not None:
        if editable.setTextContents(value):
            return
        raise RuntimeError("AT-SPI editable-text action reported failure")
    numeric = safe(lambda: accessible.queryValue(), None)
    if numeric is not None:
        try:
            number = float(value)
        except (TypeError, ValueError) as error:
            raise RuntimeError("AT-SPI numeric value requires a numeric string") from error
        if numeric.setCurrentValue(number):
            return
        raise RuntimeError("AT-SPI numeric-value action reported failure")
    raise RuntimeError("AT-SPI element has no editable value interface")


def scroll_into_view(accessible):
    component = safe(lambda: accessible.queryComponent(), None)
    if component is not None:
        mode = getattr(pyatspi, "SCROLL_ANYWHERE", None)
        if mode is not None and safe(lambda: component.scrollTo(mode), False):
            return
    perform_named_action(accessible, {"scroll to visible", "scrolltovisible"})


def execute_action(desktop, payload):
    action = payload["action"]
    max_depth = action.get("maxDepth")
    if not isinstance(max_depth, int) or max_depth < 0:
        raise RuntimeError("AT-SPI action maxDepth is invalid")
    path = parse_element_id(action.get("elementId"), max_depth)
    accessible = resolve_path(desktop, path)
    verify_identity(accessible, action)
    kind = action.get("kind")
    if kind == "focus":
        component = safe(lambda: accessible.queryComponent(), None)
        if component is None or not component.grabFocus():
            raise RuntimeError("AT-SPI element cannot receive focus")
    elif kind == "invoke":
        perform_named_action(accessible, {"click", "press", "activate", "invoke", "open"})
    elif kind == "set_value":
        set_value(accessible, action.get("value"))
    elif kind == "toggle":
        perform_named_action(accessible, {"toggle"})
    elif kind == "expand":
        expand_or_collapse(accessible, True)
    elif kind == "collapse":
        expand_or_collapse(accessible, False)
    elif kind == "select":
        perform_named_action(accessible, {"select"})
    elif kind == "scroll_into_view":
        scroll_into_view(accessible)
    else:
        raise RuntimeError("unsupported AT-SPI action")
    return {"ok": True}


def snapshot(payload):
    max_nodes = payload.get("maxNodes")
    max_depth = payload.get("maxDepth")
    max_candidates = payload.get("maxCandidates")
    if not isinstance(max_nodes, int) or max_nodes < 1:
        raise RuntimeError("AT-SPI snapshot maxNodes is invalid")
    if not isinstance(max_depth, int) or max_depth < 0:
        raise RuntimeError("AT-SPI snapshot maxDepth is invalid")
    if not isinstance(max_candidates, int) or max_candidates < 1:
        raise RuntimeError("AT-SPI snapshot maxCandidates is invalid")
    desktop = pyatspi.Registry.getDesktop(0)
    application_path = active_application_path(desktop, max_candidates)
    application = resolve_path(desktop, application_path)
    tree = accessible_node(application, application_path, 0, max_nodes, max_depth, [0])
    if tree is None:
        raise RuntimeError("AT-SPI returned no accessible application root")
    return tree


def main():
    if len(sys.argv) != 2:
        raise RuntimeError("AT-SPI helper expects one base64 payload")
    raw = base64.b64decode(sys.argv[1]).decode("utf-8")
    payload = json.loads(raw)
    if payload.get("kind") == "snapshot":
        result = snapshot(payload)
    elif payload.get("kind") == "action":
        result = execute_action(pyatspi.Registry.getDesktop(0), payload)
    else:
        raise RuntimeError("unsupported AT-SPI helper operation")
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
