import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { SemanticWorkerPool } from '../src/semantic-worker.js';

// 协议测试控制消息与退出时机，验证队列/终止边界；不模拟整个 Cordis 上下文。
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function protocol({ autoExit = true, confirmed = true } = {}) {
  const children = [];
  const messages = [];
  const sent = [];
  const runner = {
    start() {
      const exit = deferred();
      const child = { stdout: new PassThrough(), terminated: false, exited: false,
        stdin: new Writable({ write(chunk, _encoding, done) {
          const payload = JSON.parse(chunk.toString()); messages.push({ child, payload });
          sent.shift()?.resolve(messages.at(-1)); done();
        } }),
        done: exit.promise,
        terminate() { child.terminated = true; if (autoExit) child.finish(); },
        finish() { child.exited = true; exit.resolve({ exitCode: 1 }); },
        async waitForExit() { if (!confirmed) return false; await exit.promise; return true; },
        respond(payload, result = { worker_generation: `generation-${children.indexOf(child)}` }) {
          child.stdout.write(`${JSON.stringify({ id: payload.id, result })}\n`);
        },
      };
      children.push(child); return child;
    },
  };
  const pool = new SemanticWorkerPool(runner, { semanticWorkerCount: 1, commandTimeoutMs: 1000, graceMs: 1, maxAccessibilityBytes: 1000000 }, async () => 'fixture-worker');
  return { pool, children, messages, next() { const item = deferred(); sent.push(item); return item.promise; } };
}
const observation = { kind: 'acquire', owner: 'session-a', hwnd: '42' };

test('a queued deadline does not release the active request or dispatch later work concurrently', async () => {
  const p = protocol();
  try {
    const firstSent = p.next(); const first = p.pool.call(observation);
    const active = await firstSent;
    const expired = assert.rejects(p.pool.call(observation, undefined, 20), (error) => {
      assert.equal(error.executionState, 'not_started'); return /deadline/.test(error.message);
    });
    const thirdSent = p.next(); const third = p.pool.call(observation);
    await expired;
    assert.equal(p.messages.length, 1, 'queued timeout cannot dispatch a third request over the first');
    assert.equal(active.child.terminated, false, 'queued timeout cannot kill unrelated active work');
    active.child.respond(active.payload); await first;
    const later = await thirdSent; later.child.respond(later.payload); await third;
    assert.equal(p.messages.length, 2, 'expired request never reaches the native process');
  } finally { await p.pool.dispose(); }
});

test('an action deadline reports unknown only after exit confirmation, expires generation and never retries', async () => {
  const p = protocol({ autoExit: false });
  try {
    const initialSent = p.next(); const initial = p.pool.call(observation);
    const initialMessage = await initialSent; initialMessage.child.respond(initialMessage.payload);
    const observed = await initial;
    const actionSent = p.next(); const action = p.pool.call({ kind: 'act', owner: 'session-a', workerGeneration: observed.worker_generation, action: { kind: 'invoke' } }, undefined, 30);
    let settled = false;
    const rejection = assert.rejects(action, (error) => {
      settled = true; assert.equal(error.executionState, 'unknown'); return /deadline/.test(error.message);
    });
    const dispatched = await actionSent;
    // 一个短计时器只用于使协议截止发生；退出确认仍由测试显式提供。
    await new Promise((resolve) => setTimeout(resolve, 45));
    assert.equal(dispatched.child.terminated, true);
    assert.equal(settled, false, 'Promise.race cannot reply while the provider process is still alive');
    const replacementSent = p.next(); const replacement = p.pool.call(observation);
    assert.equal(p.children.length, 1, 'replacement waits for confirmed exit');
    dispatched.child.finish(); await rejection;
    const recovered = await replacementSent; recovered.child.respond(recovered.payload); await replacement;
    assert.equal(p.messages.filter((m) => m.payload.kind === 'act').length, 1, 'possibly executed action is never retried');
    await assert.rejects(p.pool.call({ ...observation, workerGeneration: observed.worker_generation }), /stale_target/);
    recovered.child.finish();
  } finally { for (const child of p.children) child.finish(); await p.pool.dispose(); }
});

test('unconfirmed termination refuses replacement rather than exceeding the worker limit', async () => {
  const p = protocol({ autoExit: false, confirmed: false });
  try {
    const next = p.next(); const pending = p.pool.call(observation, undefined, 20);
    const rejected = assert.rejects(pending, /termination could not be confirmed/);
    await next; await rejected;
    await assert.rejects(p.pool.call(observation), /termination could not be confirmed/);
    assert.equal(p.children.length, 1);
  } finally { for (const child of p.children) child.finish(); await p.pool.dispose(); }
});

test('cancellation before startup sends no native message and retains not_started', async () => {
  const p = protocol(); const controller = new AbortController(); controller.abort();
  try {
    await assert.rejects(p.pool.call(observation, controller.signal), (error) => {
      assert.equal(error.executionState, 'not_started'); return true;
    });
    assert.equal(p.children.length, 0); assert.equal(p.messages.length, 0);
  } finally { await p.pool.dispose(); }
});
