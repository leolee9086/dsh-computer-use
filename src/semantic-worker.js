// UIA/MSAA 的同步提供者调用隔离到插件自己的进程。每个请求拥有截止（含排队
// 和首次编译），超时终止进程；不能仅 Promise.race 后留下正在工作的原生调用。
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComputerUseError } from './errors.js';

const builds = new Map();
async function assembly(name) {
  const root = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'assembly', 'GAC_MSIL', name);
  for (const version of await readdir(root)) {
    const candidate = join(root, version, `${name}.dll`);
    if (existsSync(candidate)) return candidate;
  }
  throw new ComputerUseError(`Windows .NET assembly '${name}' is unavailable`);
}

export async function compileSemanticWorker(runner, signal) {
  const [worker, snapshot, locator, legacy] = await Promise.all([
    readFile(new URL('./windows-semantic-worker.cs', import.meta.url), 'utf8'),
    readFile(new URL('./windows-semantic-snapshot.cs', import.meta.url), 'utf8'),
    readFile(new URL('./windows-semantic-locator.cs', import.meta.url), 'utf8'),
    readFile(new URL('./windows-uia.cs', import.meta.url), 'utf8'),
  ]);
  const source = legacy.replace('public class Startup', 'public class NativeUia');
  const hash = createHash('sha256').update(worker).update(snapshot).update(locator).update(source).digest('hex').slice(0, 24);
  let build = builds.get(hash);
  if (build === undefined) {
    build = (async () => {
      const directory = join(tmpdir(), 'dsh-computer-use', `semantics-${hash}`);
      const executable = join(directory, 'dsh-semantics.exe');
      if (existsSync(executable)) return executable;
      await mkdir(directory, { recursive: true });
      const workerPath = join(directory, 'worker.cs');
      const snapshotPath = join(directory, 'snapshot.cs');
      const locatorPath = join(directory, 'locator.cs');
      const uiaPath = join(directory, 'uia.cs');
      await Promise.all([writeFile(workerPath, worker, 'utf8'), writeFile(snapshotPath, snapshot, 'utf8'), writeFile(locatorPath, locator, 'utf8'), writeFile(uiaPath, source, 'utf8')]);
      const references = await Promise.all(['UIAutomationClient', 'UIAutomationTypes', 'WindowsBase', 'Accessibility'].map(assembly));
      const compiler = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
      if (!existsSync(compiler)) throw new ComputerUseError('Windows .NET Framework C# compiler is unavailable');
      await runner.run([compiler, '/nologo', '/noconfig', '/target:exe', '/platform:x64', '/main:SemanticWorker', `/out:${executable}`,
        '/r:System.dll', '/r:System.Core.dll', '/r:Microsoft.CSharp.dll', '/r:System.Web.Extensions.dll', ...references.map((path) => `/r:${path}`), workerPath, snapshotPath, locatorPath, uiaPath], { signal });
      return executable;
    })();
    builds.set(hash, build);
    build.catch(() => builds.delete(hash));
  }
  return build;
}

function failure(message, state = 'not_started', code = 'COMPUTER_OPERATION_FAILED') {
  const error = new ComputerUseError(`${message} (execution_state: ${state})`, code);
  error.executionState = state;
  return error;
}

export class SemanticWorkerPool {
  constructor(runner, config, prepare = compileSemanticWorker) {
    this.prepare = prepare;
    this.runner = runner;
    this.config = config;
    this.slots = new Map();
    this.references = new Map();
    this.closed = false;
    // 有界、按目标固定分配，引用与游标总是回到创建它的工作进程。
    this.limit = config.semanticWorkerCount ?? 2;
  }

  #key(payload) {
    if (payload.workerGeneration !== undefined) {
      const slot = this.references.get(payload.workerGeneration);
      if (slot === undefined || slot.dead) throw failure('stale_target: semantic worker was restarted; observe the relevant branch again');
      return slot.key;
    }
    // 固定哈希防止打开许多窗口时无限扩池，也不为每一次查询重启 helper。
    const target = `${payload.backend ?? 'uia'}:${payload.hwnd ?? 'focused'}`;
    return createHash('sha256').update(target).digest().readUInt32LE(0) % this.limit;
  }

  #slot(key) {
    let slot = this.slots.get(key);
    if (slot === undefined || slot.dead) {
      // 被终止的进程确实退出后才能占用它的池槽，不能在重建时暂时无限扩池。
      const startBarrier = slot?.stopped ?? Promise.resolve();
      slot = { key, dead: false, tail: startBarrier, startBarrier, child: undefined, pending: new Map(), buffer: '' };
      this.slots.set(key, slot);
    }
    return slot;
  }

  async #start(slot, signal) {
    await slot.startBarrier;
    signal.throwIfAborted();
    if (slot.child !== undefined) return;
    const executable = await this.prepare(this.runner, signal);
    signal.throwIfAborted();
    if (slot.dead || this.closed) throw failure('semantic worker pool was reset during startup');
    const child = this.runner.start([executable]);
    if (child.stdin === undefined || child.stdout === undefined) {
      child.terminate(); throw failure('subprocess service did not provide semantic protocol streams');
    }
    slot.child = child;
    child.stdin.on('error', (error) => this.#drop(slot, failure(`semantic stdin failed: ${error.message}`, 'unknown')));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      slot.buffer += chunk;
      if (Buffer.byteLength(slot.buffer) > this.config.maxAccessibilityBytes + 64 * 1024) {
        this.#drop(slot, failure('semantic response exceeded its byte budget', 'unknown')); return;
      }
      let end;
      while ((end = slot.buffer.indexOf('\n')) >= 0) {
        const line = slot.buffer.slice(0, end).trim(); slot.buffer = slot.buffer.slice(end + 1);
        if (line.length === 0) continue;
        try {
          const response = JSON.parse(line);
          const request = slot.pending.get(response.id);
          if (request === undefined) continue;
          slot.pending.delete(response.id);
          if (response.error !== undefined) {
            const error = failure(response.error, response.execution_state, response.error_code);
            // 变化错误携带原生窗口身份，重新采集仍绑定原窗口，不能转向后来获得焦点的应用。
            error.observedWindow = response.observed_window;
            error.nativeCalls = response.native_calls ?? 0;
            request.reject(error);
          }
          else {
            const generation = response.result?.worker_generation;
            if (generation !== undefined) this.references.set(generation, slot);
            request.resolve(response.result);
          }
        } catch (error) { this.#drop(slot, failure(`invalid semantic response: ${error.message}`, 'unknown')); }
      }
    });
    // done 的通知不创建无人接收的拒绝 Promise；退出确认的失败由 pending 和
    // startBarrier 传给实际请求，不能变成宿主里的 unhandledRejection。
    child.done.then(() => { this.#drop(slot, failure('semantic worker exited; its references and cursors expired', 'unknown')); },
      (error) => { this.#drop(slot, failure(`semantic worker failed: ${error.message}`, 'unknown')); });
  }

  #drop(slot, error) {
    if (slot.dead) return slot.stopped;
    slot.dead = true;
    for (const [generation, registered] of this.references) if (registered === slot) this.references.delete(generation);
    const requests = [...slot.pending.values()];
    slot.pending.clear();
    slot.child?.terminate();
    // 请求错误与池槽重用都等待终止证据。waitForExit 自己的等待也有界；失败时
    // 保留拒绝的 stopped，后续请求不能在旧进程尚存时偷偷启动替代进程。
    slot.stopped = (async () => {
      if (slot.child !== undefined) {
        const exited = await slot.child.waitForExit(AbortSignal.timeout(this.config.graceMs + 1000));
        if (!exited) throw failure('semantic worker termination could not be confirmed', error.executionState);
      }
    })();
    slot.stopped.then(() => { for (const request of requests) request.reject(error); },
      (stopError) => { for (const request of requests) request.reject(stopError); });
    return slot.stopped;
  }

  async call(payload, signal, timeoutMs = this.config.commandTimeoutMs) {
    if (this.closed) throw failure('semantic worker pool is disposed');
    const slot = this.#slot(this.#key(payload));
    const requestedAt = performance.now();
    const deadline = Date.now() + timeoutMs;
    const controller = new AbortController();
    let dispatched = false;
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let rejectAbort;
    const aborted = new Promise((_resolve, reject) => { rejectAbort = reject; });
    const stop = () => {
      const error = failure(`semantic request ${signal?.aborted ? 'cancelled' : 'exceeded its deadline'}; ${dispatched ? 'worker terminated and references expired' : 'not started'}`,
        dispatched && payload.kind === 'act' && payload.action?.kind !== 'read' ? 'unknown' : 'not_started');
      if (dispatched) this.#drop(slot, error).then(() => rejectAbort(error), rejectAbort);
      else rejectAbort(error);
    };
    controller.signal.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const predecessor = slot.tail;
    const task = predecessor.then(async () => {
      controller.signal.throwIfAborted();
      if (slot.dead) throw failure('semantic worker was reset while request was queued');
      const queuedMs = performance.now() - requestedAt;
      const startingAt = performance.now();
      await this.#start(slot, controller.signal);
      const startupMs = performance.now() - startingAt;
      controller.signal.throwIfAborted();
      const budgetMs = Math.max(1, Math.min(payload.budgetMs ?? 5000, deadline - Date.now() - 50));
      const id = randomUUID();
      const result = await new Promise((resolve, reject) => {
        slot.pending.set(id, { resolve, reject });
        dispatched = true;
        slot.child.stdin.write(`${JSON.stringify({ ...payload, id, budgetMs })}\n`);
      });
      if (['acquire', 'locate'].includes(payload.kind) && result && typeof result === 'object') {
        result.host_timing = { queue_ms: Math.round(queuedMs), startup_ms: Math.round(startupMs), elapsed_ms: Math.round(performance.now() - requestedAt) };
      }
      return result;
    });
    // 外层截止可以先回复排队请求，但队列仍等待前一个真实任务完成；否则一个
    // 未执行请求的超时会放行下一请求，破坏每个工作进程一次只处理一个请求的合同。
    slot.tail = task.catch(() => undefined);
    try {
      if (controller.signal.aborted) stop();
      return await Promise.race([aborted, task]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', stop);
    }
  }

  async dispose() {
    this.closed = true;
    const children = [...this.slots.values()].map((slot) => slot.child).filter(Boolean);
    for (const slot of this.slots.values()) this.#drop(slot, failure('semantic worker pool disposed', 'unknown'));
    await Promise.allSettled(children.map((child) => child.waitForExit(AbortSignal.timeout(this.config.graceMs + 1000))));
  }
}
