// Native macOS pointer bridge for dsh-computer-use.
// osascript runs this file with one base64 JSON action argument.

ObjC.import('Foundation');
ObjC.import('CoreGraphics');

function decodePayload(value) {
  const data = $.NSData.alloc.initWithBase64EncodedStringOptions(value, 0);
  if (data === null) throw new Error('macOS input payload is invalid');
  const text = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
  return JSON.parse(text);
}

function finite(value, name) {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`${name} must be finite`);
  return Math.round(result);
}

function pointOf(value, label) {
  if (value === null || typeof value !== 'object') throw new Error(`${label} is invalid`);
  return { x: finite(value.x, `${label}.x`), y: finite(value.y, `${label}.y`) };
}

function mouseButton(button) {
  if (button === 'left') return $.kCGMouseButtonLeft;
  if (button === 'middle') return $.kCGMouseButtonCenter;
  if (button === 'right') return $.kCGMouseButtonRight;
  throw new Error(`unsupported mouse button '${button}'`);
}

function mouseEvent(kind, point, button, clickState) {
  const eventType = kind === 'move'
    ? $.kCGEventMouseMoved
    : kind === 'drag'
      ? button === 'left' ? $.kCGEventLeftMouseDragged : button === 'right' ? $.kCGEventRightMouseDragged : $.kCGEventOtherMouseDragged
      : kind === 'down'
        ? button === 'left' ? $.kCGEventLeftMouseDown : button === 'right' ? $.kCGEventRightMouseDown : $.kCGEventOtherMouseDown
        : button === 'left' ? $.kCGEventLeftMouseUp : button === 'right' ? $.kCGEventRightMouseUp : $.kCGEventOtherMouseUp;
  const event = $.CGEventCreateMouseEvent(null, eventType, $.CGPointMake(point.x, point.y), mouseButton(button));
  if (event === null) throw new Error('CGEventCreateMouseEvent returned null');
  if (clickState !== undefined) $.CGEventSetIntegerValueField(event, $.kCGMouseEventClickState, clickState);
  return event;
}

function post(event) {
  $.CGEventPost($.kCGHIDEventTap, event);
}

function sleep(milliseconds) {
  if (milliseconds > 0) $.NSThread.sleepForTimeInterval(milliseconds / 1000);
}

function click(action) {
  const point = pointOf(action.point, 'click point');
  const button = action.button || 'left';
  const count = action.clickCount === 2 ? 2 : 1;
  post(mouseEvent('move', point, button));
  for (let index = 1; index <= count; index += 1) {
    post(mouseEvent('down', point, button, index));
    post(mouseEvent('up', point, button, index));
    sleep(40);
  }
}

function drag(action) {
  const from = pointOf(action.from, 'drag start');
  const to = pointOf(action.to, 'drag end');
  const duration = Math.max(0, Math.min(10_000, finite(action.durationMs ?? 0, 'durationMs')));
  const steps = Math.max(1, Math.min(120, Math.ceil(duration / 16)));
  post(mouseEvent('move', from, 'left'));
  post(mouseEvent('down', from, 'left'));
  try {
    for (let index = 1; index <= steps; index += 1) {
      const fraction = index / steps;
      const point = {
        x: Math.round(from.x + (to.x - from.x) * fraction),
        y: Math.round(from.y + (to.y - from.y) * fraction),
      };
      if (duration > 0) sleep(duration / steps);
      post(mouseEvent('drag', point, 'left'));
    }
  } finally {
    post(mouseEvent('up', to, 'left'));
  }
}

function scroll(action) {
  const point = pointOf(action.point, 'scroll point');
  const deltaX = finite(action.deltaX, 'deltaX');
  const deltaY = finite(action.deltaY, 'deltaY');
  const vertical = Math.trunc(deltaY / 120) || Math.sign(deltaY);
  const horizontal = Math.trunc(deltaX / 120) || Math.sign(deltaX);
  if (vertical === 0 && horizontal === 0) throw new Error('scroll requires a non-zero delta');
  post(mouseEvent('move', point, 'left'));
  const event = $.CGEventCreateScrollWheelEvent(null, $.kCGScrollEventUnitLine, 2, vertical, horizontal);
  if (event === null) throw new Error('CGEventCreateScrollWheelEvent returned null');
  post(event);
}

function run(argv) {
  if (!Array.isArray(argv) || argv.length !== 1) throw new Error('macOS input helper expects one base64 action');
  const action = decodePayload(argv[0]);
  if (action.kind === 'move') post(mouseEvent('move', pointOf(action.point, 'move point'), 'left'));
  else if (action.kind === 'click') click(action);
  else if (action.kind === 'drag') drag(action);
  else if (action.kind === 'scroll') scroll(action);
  else throw new Error(`unsupported macOS input action '${action.kind}'`);
  return JSON.stringify({ ok: true });
}
