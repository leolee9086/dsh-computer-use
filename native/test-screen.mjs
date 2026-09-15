/**
 * 验证 dsh-screen 原生 helper。
 *
 * 覆盖点（每一条都是宿主侧依赖的行为）：
 *   1. list-displays 能列出显示器，坐标与 computer_status 一致
 *   2. 区域截图：**sourceBounds 必须等于请求的区域**（宿主靠它换算点击坐标）
 *   3. 越界区域被裁到虚拟桌面内，且如实回报实际边界
 *   4. 完全越界时报错（而不是返回一张黑图）
 *   5. scale 放大后，sourceBounds 保持不变（只影响像素密度，不影响坐标语义）
 *
 * 产出 PNG 落到 native/out/，方便肉眼看结果。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const execute = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const exe = join(here, 'target', 'release', 'dsh-screen.exe')
const outDir = join(here, 'out')
mkdirSync(outDir, { recursive: true })

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  OK   ${name}${detail ? '  ' + detail : ''}`) }
  else { fail++; console.log(` FAIL  ${name}  ${detail}`) }
}

/** 调 exe：screenshot 走 stdin，其余走 argv */
async function run(args, payload) {
  const opts = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  if (payload !== undefined) {
    opts.input = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
  }
  const { stdout } = await execute(exe, args, opts)
  return JSON.parse(stdout)
}

function savePng(name, b64) {
  const file = join(outDir, name)
  writeFileSync(file, Buffer.from(b64, 'base64'))
  return file
}

/* ---------------- 1) 显示器 ---------------- */

console.log('=== 1) list-displays ===')
let displays = []
try {
  displays = await run(['list-displays'])
  check('能列出显示器', Array.isArray(displays) && displays.length > 0, `${displays.length} 个`)
  for (const d of displays) {
    console.log(`     ${d.id}  ${d.bounds.x},${d.bounds.y} ${d.bounds.width}x${d.bounds.height} primary=${d.primary}`)
  }
  const primary = displays.filter((d) => d.primary)
  check('恰有一个主显示器', primary.length === 1, `primary=${primary.map((d) => d.id).join(',')}`)
} catch (err) {
  check('能列出显示器', false, err.message.split('\n')[0])
}

/* ---------------- 2) 区域截图 ---------------- */

const target = displays.find((d) => d.primary) ?? displays[0]
const region = { x: target.bounds.x + 200, y: target.bounds.y + 200, width: 400, height: 300 }

console.log('\n=== 2) 区域截图（宿主坐标换算的基础）===')
try {
  const shot = await run(['screenshot'], { region, maxDimension: 1920, maxBytes: 12_000_000 })
  check('返回了 PNG', typeof shot.png === 'string' && shot.png.length > 100, `${shot.png.length} 字符 base64`)
  check('图像尺寸等于请求区域', shot.width === region.width && shot.height === region.height,
    `${shot.width}x${shot.height} vs 请求 ${region.width}x${region.height}`)
  check('sourceBounds 等于请求区域（点击坐标靠它换算）',
    shot.sourceBounds.x === region.x && shot.sourceBounds.y === region.y
    && shot.sourceBounds.width === region.width && shot.sourceBounds.height === region.height,
    JSON.stringify(shot.sourceBounds))
  const f = savePng('region-400x300.png', shot.png)
  console.log(`     已保存 ${f}`)
} catch (err) {
  check('区域截图', false, err.message.split('\n')[0])
}

/* ---------------- 3) 越界区域 ---------------- */

console.log('\n=== 3) 越界区域：应裁剪而不是黑边 ===')
try {
  // 故意让右上角超出：宽高给得比屏幕还大
  const wild = { x: target.bounds.x + target.bounds.width - 100, y: target.bounds.y + target.bounds.height - 50, width: 500, height: 300 }
  const shot = await run(['screenshot'], { region: wild, maxDimension: 1920, maxBytes: 12_000_000 })
  const expectedW = Math.min(wild.width, target.bounds.width - (wild.x - target.bounds.x))
  check('越界后被裁到屏幕内', shot.width < wild.width, `实际 ${shot.width}x${shot.height}`)
  check('sourceBounds 回报的是裁剪后的真实区域',
    shot.sourceBounds.width === shot.width && shot.sourceBounds.height === shot.height,
    JSON.stringify(shot.sourceBounds))
  console.log(`     请求 ${wild.width}x${wild.height} → 实际 ${shot.width}x${shot.height}（期望宽 ${expectedW}）`)
} catch (err) {
  check('越界裁剪', false, err.message.split('\n')[0])
}

/* ---------------- 4) 完全越界 ---------------- */

console.log('\n=== 4) 完全越界：应报错 ===')
try {
  await run(['screenshot'], { region: { x: 999_999, y: 999_999, width: 100, height: 100 }, maxDimension: 1920, maxBytes: 12_000_000 })
  check('完全越界应报错', false, '却成功返回了')
} catch (err) {
  const msg = (err.stderr ?? err.message ?? '').toString()
  check('完全越界报错', /虚拟桌面之外|outside/.test(msg), msg.split('\n')[0].slice(0, 120))
}

/* ---------------- 5) scale 放大 ---------------- */

console.log('\n=== 5) scale 放大（看小字用）===')
try {
  const small = { x: target.bounds.x + 300, y: target.bounds.y + 300, width: 200, height: 150 }
  const shot = await run(['screenshot'], { region: small, scale: 2, maxDimension: 1920, maxBytes: 12_000_000 })
  check('放大后像素翻倍', shot.width === 400 && shot.height === 300, `${shot.width}x${shot.height}`)
  check('放大不改变 sourceBounds（坐标语义不变）',
    shot.sourceBounds.width === small.width && shot.sourceBounds.height === small.height,
    JSON.stringify(shot.sourceBounds))
  savePng('region-2x.png', shot.png)
} catch (err) {
  check('scale 放大', false, err.message.split('\n')[0])
}

/* ---------------- 6) 整屏 + maxDimension ---------------- */

console.log('\n=== 6) 整屏截图受 maxDimension 限制 ===')
try {
  const shot = await run(['screenshot'], { displayId: target.id, maxDimension: 800, maxBytes: 12_000_000 })
  check('整屏被限制到 maxDimension', Math.max(shot.width, shot.height) <= 800, `${shot.width}x${shot.height}`)
  check('整屏 sourceBounds 等于显示器边界',
    shot.sourceBounds.width === target.bounds.width && shot.sourceBounds.height === target.bounds.height,
    JSON.stringify(shot.sourceBounds))
  savePng('display-fit800.png', shot.png)
} catch (err) {
  check('整屏截图', false, err.message.split('\n')[0])
}

console.log(`\n=== 合计 ${pass + fail} 项，失败 ${fail} 项 ===`)
process.exitCode = fail === 0 ? 0 : 1
