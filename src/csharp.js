// 通用 C# 桥：用 edge-js 在**同一个 Node 进程内**编译并调用 .cs 文件。
//
// 为什么不做成「一个 .cs 配一个专门的 js」：那等于把「加载 + 互操作 + 编组 + 池化」
// 这几件事按文件复制一遍，每加一个 C# 能力就要再写一个桥文件。这里只做一件事 ——
// **把任意 .cs 文件变成一个 Promise 化的可调用函数** —— 具体能力由那个 .cs
// 自己按 `input.kind` 分发，桥不关心它是什么。
//
// 与原来的 PowerShell 路线相比，省掉的是：每做一次动作 spawn 一个解释器进程、
// 现场 Add-Type 编译一遍 C#、再由它转发调用。现在是进程内直接调用，且只编译有限次。
//
// 三个实测出来的环境事实：
//   1. **程序集引用必须给完整路径。** 像 UIAutomationClient 这样的程序集在 GAC 里，
//      而 csc 只查框架目录、不查 GAC，所以 `#r "UIAutomationClient.dll"` 这种短名解析不到。
//      调用方只给程序集**名字**，由这里解析成 GAC 里的完整路径传给 edge.func。
//   2. **Windows 上 edge-js 默认跑 .NET Framework 4.5**，而 `references` 选项只在
//      那个模式下有效（CoreCLR 要走 project.json 那一套）。这正是我们要的模式。
//   3. **单个 edge 函数实例不能并发调用。** 见下面 Bridge 的说明 —— 这是池化存在的理由。

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ComputerUseError } from './errors.js';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/**
 * 一个 C# 源文件的并发调用池。
 *
 * 为什么要池化（这不是优化，是正确性）：**一个 edge 函数实例不能同时跑两次调用**。
 * DSH 里同一个会话可以有多个工具调用在飞，而一次 UIA 遍历本身要几百毫秒 ——
 * 共用一个实例会让第二个调用排在被占用的实例后面干等，或者直接出错。
 * 所以这里维持一组互相独立的实例：有空闲的就用，没有就按上限新建，到顶了就排队。
 *
 * 每个实例都是**独立编译**出来的：源字符串末尾加上 `//pool:N` 让它与别的实例
 * 不是同一份源码 —— 否则 edge 会复用同一个编译结果，池子就形同虚设。
 */
class Bridge {
  constructor(edge, source, references, limit) {
    this.edge = edge;
    this.source = source;
    this.references = references;
    this.limit = limit;
    this.instances = [];
    this.waiting = [];
  }

  /** 造一个新实例。`//pool:N` 只为让源码字符串不同，不改变 C# 的行为。 */
  #create() {
    const index = this.instances.length;
    const raw = this.edge.func({
      source: `${this.source}\n//pool:${index}`,
      references: this.references,
    });
    const instance = { raw, busy: true };
    this.instances.push(instance);
    return instance;
  }

  /** 取一个实例：优先空闲的，其次新建，都满了就排队等别人放开。 */
  async #acquire() {
    for (const instance of this.instances) {
      if (!instance.busy) {
        instance.busy = true;
        return instance;
      }
    }
    if (this.instances.length < this.limit) return this.#create();
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  /** 放开实例。有人在排队就直接转交（它仍是 busy 状态），不必先标记空闲再唤醒。 */
  #release(instance) {
    const next = this.waiting.shift();
    if (next !== undefined) {
      next(instance);
      return;
    }
    instance.busy = false;
  }

  /** 调用一次。失败也要放开实例，否则一次报错就会永久占掉一个池位。 */
  async call(payload) {
    const instance = await this.#acquire();
    try {
      return await new Promise((resolve, reject) => {
        try {
          instance.raw(payload, (error, result) => {
            if (error) reject(error);
            else resolve(result);
          });
        } catch (cause) {
          reject(cause);
        }
      });
    } finally {
      this.#release(instance);
    }
  }
}

/**
 * 在 GAC 里按名字解析程序集的完整路径。
 *
 * GAC 的目录结构是 `<名字>\<版本>__<公钥标记>\<名字>.dll`；版本号那段不能写死
 * （不同系统上可能是 4.0.0.0 或别的），所以列一次目录、取第一个真实存在的。
 */
function resolveGacAssembly(name) {
  const root = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'assembly', 'GAC_MSIL', name);
  if (!existsSync(root)) return undefined;
  for (const version of readdirSync(root)) {
    const candidate = join(root, version, `${name}.dll`);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * 池的上限。
 *
 * 用 `availableParallelism()` 而不是 `cpus().length`：后者报的是物理核数，
 * 在容器/受限环境里会高估。下限 2 保证「一个在跑、一个能接活」，上限 8 免得
 * 一个闲置很久的能力白占一堆 CLR 实例（每个实例都是独立的编译产物）。
 */
function poolLimit() {
  return Math.max(2, Math.min(8, availableParallelism()));
}

/** 加载过的桥按「源码路径 + 引用清单」缓存，同一个文件只建一个池。 */
const bridges = new Map();

let edgeCsPrepared = false;

/**
 * 把 edge-cs 的原生 DLL 复制到一个纯 ASCII 路径，并用 `EDGE_CS_NATIVE` 指过去。
 *
 * 这是从 SAC 项目迁移过来的做法（它那边的注释写的是「解决 Windows 下非 ASCII 字符路径问题」）：
 * edge-cs 加载自己的原生 DLL 时对非 ASCII 路径支持不好，而本插件很可能被装在
 * `C:\Users\<中文用户名>\.dsh\...` 这类路径下 —— 那就是每次编译都失败。
 * 复制一份到 `%ALLUSERSPROFILE%` 下的 ASCII 路径即可绕开；目标目录按包名分开，
 * 免得和别的插件互相覆盖。必须在 `import('edge-js')` **之前**设好。
 */
function prepareEdgeCsNative() {
  if (edgeCsPrepared) return;
  edgeCsPrepared = true;
  try {
    // 从 edge-js 自身的位置推它自带的 edge-cs：require.resolve 到 .dll 会被 package
    // exports 挡住，而 edge-js 把 edge-cs 装在自己的 node_modules 里。
    const edgeJsRoot = dirname(dirname(require.resolve('edge-js')));
    const source = join(edgeJsRoot, 'node_modules', 'edge-cs', 'lib', 'edge-cs.dll');
    if (!existsSync(source)) return;   // 布局不同就交给 edge-cs 自己找，不硬来

    const target = join(process.env.ALLUSERSPROFILE ?? tmpdir(), 'dsh-computer-use');
    mkdirSync(target, { recursive: true });
    const destination = join(target, 'edge-cs.dll');
    copyFileSync(source, destination);
    process.env.EDGE_CS_NATIVE = destination;
  } catch {
    // 复制失败不致命：路径本来就是 ASCII 时根本不需要这一步。
    // 真出问题会在编译时报出来，那时这条线索（路径含非 ASCII）才有用。
  }
}

/** 懒加载 edge-js。它在可选依赖里（原生模块，只有需要 C# 的能力才用得上）。 */
async function requireEdge() {
  prepareEdgeCsNative();
  try {
    return (await import('edge-js')).default;
  } catch (cause) {
    throw new ComputerUseError(
      '这段能力需要 edge-js（在 Node 进程内调用 .NET）；它在可选依赖里，可能是安装时被跳过了',
      { cause },
    );
  }
}

/**
 * 把 `src/` 下的一个 .cs 文件加载成可调用函数。
 *
 * @param {string} fileName `src/` 下的文件名，例如 `windows-uia.cs`
 * @param {{ references?: string[] }} [options] `references` 是程序集**名字**列表
 *   （例如 `['UIAutomationClient', 'UIAutomationTypes']`），由桥解析成 GAC 完整路径；
 *   调用方不必知道 GAC 的目录结构。
 * @returns {Promise<(payload: unknown) => Promise<unknown>>} 传入 payload、拿回结果的函数
 */
export async function loadCSharpFile(fileName, options = {}) {
  const references = options.references ?? [];
  const key = `${fileName}\u0000${references.join(',')}`;
  const cached = bridges.get(key);
  if (cached !== undefined) return cached;

  const assemblyPaths = references.map(resolveGacAssembly);
  const missing = references.filter((_, index) => assemblyPaths[index] === undefined);
  if (missing.length > 0) {
    throw new ComputerUseError(
      `需要的 .NET 程序集在 GAC 里找不到：${missing.join(', ')}；`
      + '它们随 .NET Framework 4.x 一起安装，缺少说明系统组件不完整',
    );
  }

  const edge = await requireEdge();
  const source = readFileSync(join(here, fileName), 'utf8');
  const bridge = new Bridge(edge, source, assemblyPaths.filter((value) => value !== undefined), poolLimit());

  const call = (payload) => bridge.call(payload);
  bridges.set(key, call);
  return call;
}
