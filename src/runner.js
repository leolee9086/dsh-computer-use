import { ComputerUseError, unavailable } from './errors.js';

function outputOf(reader) {
  return reader === undefined
    ? { text: '', lossy: false }
    : reader.readFrom(0);
}

function mergeAbortSignal(signal, timeoutMs) {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal.reason);
  if (signal?.aborted) controller.abort(signal.reason);
  else signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timer = setTimeout(() => controller.abort(new ComputerUseError(
    `desktop command exceeded ${timeoutMs}ms`,
    'COMPUTER_OPERATION_FAILED',
  )), timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortFromCaller);
    },
  };
}

function abortedError(signal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new ComputerUseError('desktop command was aborted');
}

export class ManagedRunner {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
  }

  async resolveAny(candidates, signal) {
    for (const candidate of candidates) {
      signal?.throwIfAborted();
      try {
        return await this.ctx.subprocess.resolveExecutable(candidate, undefined, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        // Availability probing intentionally tries the next platform command.
      }
    }
    signal?.throwIfAborted();
    return undefined;
  }

  async run(argv, options = {}) {
    const stdoutMaxBytes = options.stdoutMaxBytes ?? this.config.maxAccessibilityBytes;
    const stderrMaxBytes = Math.min(stdoutMaxBytes, 256 * 1024);
    const linked = mergeAbortSignal(options.signal, this.config.commandTimeoutMs);
    // 允许调用方给子进程喂 stdin（原生 helper 用它传请求参数）。
    // 默认仍是 'ignore'：多数平台命令用不到 stdin，忽略掉最省事也更安全。
    // 批式 stdin 的字段名必须是 `data`：DSH 的 SubprocessStdinMode 是
    // 'ignore' | 'pipe' | { data: string }，实现侧执行 stdin.end(stdinMode.data)。
    // 写成 { text } 时 data 是 undefined —— 管道被立刻关闭，子进程读到空输入，
    // payload 被静默丢掉（截图参数 region / display_id / scale 会全部不生效）。
    const stdinOption = typeof options.stdin === 'string'
      ? { data: options.stdin }
      : options.stdin !== undefined && options.stdin !== null
        ? options.stdin
        : 'ignore';
    let child;
    try {
      if (linked.signal.aborted) throw abortedError(linked.signal);
      child = this.ctx.subprocess.spawn({
        argv,
        cwd: process.cwd(),
        stdio: {
          stdin: stdinOption,
          stdout: { maxBytes: stdoutMaxBytes, spill: { maxBytes: stdoutMaxBytes } },
          stderr: { maxBytes: stderrMaxBytes, spill: { maxBytes: stderrMaxBytes } },
        },
        graceMs: this.config.graceMs,
        signal: linked.signal,
      });
      const outcome = await child.done;
      const stdout = outputOf(child.collected.stdout);
      const stderr = outputOf(child.collected.stderr);
      if (linked.signal.aborted) {
        throw abortedError(linked.signal);
      }
      if (outcome.exitCode !== 0 || outcome.signal !== null) {
        const detail = stderr.text.trim() || stdout.text.trim() || `exit ${outcome.exitCode ?? outcome.signal}`;
        throw new ComputerUseError(`desktop command failed: ${detail}`);
      }
      if (stdout.lossy) {
        throw new ComputerUseError(`desktop command exceeded its ${stdoutMaxBytes}-byte stdout limit`);
      }
      return stdout.text;
    } catch (error) {
      if (linked.signal.aborted) throw abortedError(linked.signal);
      if (error instanceof ComputerUseError) throw error;
      throw new ComputerUseError(`desktop command could not start: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      linked.dispose();
    }
  }

  async runJson(argv, options = {}) {
    const stdout = await this.run(argv, options);
    try {
      return JSON.parse(stdout);
    } catch (error) {
      throw new ComputerUseError(`desktop helper returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async requireAny(candidates, capability, signal) {
    const executable = await this.resolveAny(candidates, signal);
    if (executable === undefined) {
      throw unavailable(`${capability} is unavailable: install one of ${candidates.join(', ')}`);
    }
    return executable;
  }
}
