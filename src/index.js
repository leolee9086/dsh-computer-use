// src/index.js — dsh-computer-use bundle 主入口(裸包名行的宿主半部)。
//
// 职责划分(保持不变,各自独立 config 可被 profile patch 按 id 覆盖):
// - 裸名行 `dsh-computer-use`(本入口) → re-export host.js 的平台服务插件,
//   同时作为 client-modules 浏览器扫描的锚点:package.json 声明
//   `dsh.client.platform = "web"` 与 `exports["./client"]`,浏览器半部
//   (src/client.js,computer_screenshot 工具卡)因此进入 __DSH_BOOT__。
// - 子路径行 `dsh-computer-use/tool` → 工具注册(tool.js)
// - 子路径行 `dsh-computer-use/prompt` → 工作流提示词段(prompt.js)
//
// 注意:裸名行必须承载 host 插件本体(re-export 而非重复挂载),否则
// `provide('computer')` 会与原有行冲突;同时 host 子路径行已删除,
// 由本裸名行取代。
export { name, inject, apply } from './host.js';
