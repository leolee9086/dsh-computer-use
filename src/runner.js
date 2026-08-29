import { ComputerUseError, unavailable } from './errors.js';

function textOf(reader) {
  return reader === undefined ? '' : reader.readFrom(0).text;
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

export class ManagedRunner {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
  }

  async resolveAny(candidates, signal) {
    for (const candidate of candidates) {
      try {
        return await this.ctx.subprocess.resolveExecutable(candidate, undefined, signal);
      } catch {
        // Availability probing intentionally tries the next platform command.
      }
    }
    return undefined;
  }

  async run(argv, options = {}) {
    const stdoutMaxBytes = options.stdoutMaxBytes ?? this.config.maxAccessibilityBytes;
    const stderrMaxBytes = Math.min(stdoutMaxBytes, 256 * 1024);
    const linked = mergeAbortSignal(options.signal, this.config.commandTimeoutMs);
    let child;
    try {
      child = this.ctx.subprocess.spawn({
        argv,
        cwd: process.cwd(),
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: stdoutMaxBytes, spill: { maxBytes: stdoutMaxBytes } },
          stderr: { maxBytes: stderrMaxBytes, spill: { maxBytes: stderrMaxBytes } },
        },
        graceMs: this.config.graceMs,
        signal: linked.signal,
      });
      const outcome = await child.done;
      const stdout = textOf(child.collected.stdout);
      const stderr = textOf(child.collected.stderr);
      if (linked.signal.aborted) {
        throw linked.signal.reason instanceof Error
          ? linked.signal.reason
          : new ComputerUseError('desktop command was aborted');
      }
      if (outcome.exitCode !== 0 || outcome.signal !== null) {
        const detail = stderr.trim() || stdout.trim() || `exit ${outcome.exitCode ?? outcome.signal}`;
        throw new ComputerUseError(`desktop command failed: ${detail}`);
      }
      return stdout;
    } catch (error) {
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
