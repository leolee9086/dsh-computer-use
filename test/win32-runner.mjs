// 真机 smoke 测试共用的 runner。
//
// 为什么不用 `execFile`：原生 helper（dsh-screen.exe）的请求体走 **stdin**
// （base64(UTF8 JSON)），而异步版 `execFile` 没有 `input` 选项 —— 用它就得手动
// 往子进程的 stdin 写。这里包一层 spawn 做这件事，两个 smoke 测试共用。
//
// 注意：**不喂 stdin 会让 helper 一直等下去**（它按协议先读请求体再干活），
// 表现就是测试挂住不返回 —— 所以下面无论有没有 payload 都要显式 end()。

import { spawn } from 'node:child_process';

/** 跑一个子进程，把 `stdin` 写进去，收集 stdout 并解析成 JSON。 */
export function createRunner() {
  return {
    // 这一层已经不再需要探测 PowerShell 了；保留方法是因为 runner 契约里还有它。
    async requireAny() { return 'powershell.exe'; },

    async runJson(argv, options = {}) {
      const stdout = await new Promise((resolve, reject) => {
        const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
        const limit = options.stdoutMaxBytes ?? 16 * 1024 * 1024;
        let collected = '';
        let stderr = '';
        let size = 0;
        let settled = false;

        const fail = (error) => {
          if (settled) return;
          settled = true;
          child.kill();
          reject(error);
        };

        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          size += chunk.length;
          if (size > limit) {
            fail(new Error(`stdout 超过 ${limit} 字节上限`));
            return;
          }
          collected += chunk;
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', fail);
        child.on('close', (code) => {
          if (settled) return;
          settled = true;
          if (stderr.trim() !== '') process.stderr.write(stderr);
          if (code !== 0) {
            reject(new Error(`${argv[0]} 以退出码 ${code} 结束`));
            return;
          }
          resolve(collected);
        });

        if (options.stdin === undefined) child.stdin.end();
        else child.stdin.end(options.stdin);
      });

      return JSON.parse(stdout);
    },
  };
}
