/**
 * 探针：搞清 powershell.exe (5.1) 里 SystemInformation::VirtualScreen 到底返回什么，
 * 以及几种替代写法哪种可靠。一次跑完，别再用命令行猜。
 *
 * 用 node 跑：node test/probe-virtualscreen.mjs
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const execute = promisify(execFile)

const script = `
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Show($label, $value, $err) {
  if ($err) { "[$label] ERROR: $($err.Exception.Message)" }
  else { "[$label] $value" }
}

# 候选 1：直接静态属性
try {
  $v = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $t = if ($null -eq $v) { 'NULL' } else { $v.GetType().FullName }
  Show 'A: SystemInformation::VirtualScreen' "type=$t X=$($v.X) Y=$($v.Y) W=$($v.Width) H=$($v.Height)"
} catch { Show 'A' $null $_ }

# 候选 2：属性单独取，看是否 null
try {
  $x = [System.Windows.Forms.SystemInformation]::VirtualScreen.X
  Show 'B: .VirtualScreen.X 单独取' "X=$x"
} catch { Show 'B' $null $_ }

# 候选 3：AllScreens 求并集（不依赖 VirtualScreen）
try {
  $screens = [System.Windows.Forms.Screen]::AllScreens
  Show 'C: AllScreens 数量' "$($screens.Count)"
  foreach ($s in $screens) {
    "[C]   $($s.DeviceName) bounds=$($s.Bounds.X),$($s.Bounds.Y) $($s.Bounds.Width)x$($s.Bounds.Height) primary=$($s.Primary)"
  }
  $minX = ($screens | ForEach-Object { $_.Bounds.X } | Measure-Object -Minimum).Minimum
  $minY = ($screens | ForEach-Object { $_.Bounds.Y } | Measure-Object -Minimum).Minimum
  $maxR = ($screens | ForEach-Object { $_.Bounds.X + $_.Bounds.Width } | Measure-Object -Maximum).Maximum
  $maxB = ($screens | ForEach-Object { $_.Bounds.Y + $_.Bounds.Height } | Measure-Object -Maximum).Maximum
  Show 'C: 并集' "x=$minX y=$minY w=$($maxR - $minX) h=$($maxB - $minY)"
} catch { Show 'C' $null $_ }

# 候选 4：PSVersion
Show 'D: PSVersion' "$($PSVersionTable.PSVersion)"

# 候选 5：hashtable 属性访问 vs 索引访问（我的新代码用了 $bounds.X）
try {
  $h = @{ X = 5; Y = 6; Width = 100; Height = 50 }
  Show 'E: hashtable $h.X' "X=$($h.X) 索引X=$($h['X'])"
} catch { Show 'E' $null $_ }

# 候选 6：DPR 感知调用之后 VirtualScreen 是否还正常
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DpiProbe {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@ -Language CSharp
  [DpiProbe]::SetProcessDPIAware() | Out-Null
  $v2 = [System.Windows.Forms.SystemInformation]::VirtualScreen
  Show 'F: SetProcessDPIAware 之后' "type=$($v2.GetType().FullName) X=$($v2.X) W=$($v2.Width)"
} catch { Show 'F' $null $_ }
`

const file = join(tmpdir(), 'dsh-probe-virtualscreen.ps1')
writeFileSync(file, script, 'utf8')

for (const shell of ['powershell.exe', 'pwsh.exe']) {
  console.log(`\n================ ${shell} ================`)
  try {
    const { stdout, stderr } = await execute(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', file], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    })
    console.log(stdout.trim())
    if (stderr.trim() !== '') console.log('--- stderr ---\n' + stderr.trim())
  } catch (err) {
    console.log('执行失败：' + err.message)
    if (err.stdout) console.log(String(err.stdout).trim())
    if (err.stderr) console.log('--- stderr ---\n' + String(err.stderr).trim())
  }
}
