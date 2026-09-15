/**
 * 最小探针（纯 ASCII，排除编码干扰）：
 * powershell.exe 5.1 下 SystemInformation::VirtualScreen 到底能不能用？
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const execute = promisify(execFile)

const script = [
  "Add-Type -AssemblyName System.Windows.Forms",
  "Add-Type -AssemblyName System.Drawing",
  "Write-Output ('PSVersion=' + $PSVersionTable.PSVersion.ToString())",
  "$v = [System.Windows.Forms.SystemInformation]::VirtualScreen",
  "Write-Output ('virtual_null=' + ($null -eq $v))",
  "Write-Output ('virtual_type=' + $(if ($null -eq $v) { 'NULL' } else { $v.GetType().FullName }))",
  "$x = [System.Windows.Forms.SystemInformation]::VirtualScreen.X",
  "Write-Output ('virtual_X=' + $x)",
  "try { Write-Output ('virtual_X2=' + $v.X) } catch { Write-Output ('virtual_X2_ERR=' + $_.Exception.Message) }",
  "$screens = [System.Windows.Forms.Screen]::AllScreens",
  "Write-Output ('screens=' + $screens.Count)",
  "$minX = ($screens | ForEach-Object { $_.Bounds.X } | Measure-Object -Minimum).Minimum",
  "Write-Output ('union_minX=' + $minX)",
].join('\n')

const utf8NoBom = join(tmpdir(), 'dsh-probe-ascii.ps1')
const utf8Bom = join(tmpdir(), 'dsh-probe-ascii-bom.ps1')
writeFileSync(utf8NoBom, script, 'utf8')
writeFileSync(utf8Bom, '\uFEFF' + script, 'utf8')

for (const [label, file] of [['UTF8 无BOM', utf8NoBom], ['UTF8 带BOM', utf8Bom]]) {
  for (const shell of ['powershell.exe', 'pwsh.exe']) {
    process.stdout.write(`\n=== ${shell} / ${label} ===\n`)
    try {
      const { stdout, stderr } = await execute(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', file], {
        encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
      })
      process.stdout.write(stdout.trim() + '\n')
      if (stderr.trim() !== '') process.stdout.write('stderr: ' + stderr.trim().slice(0, 300) + '\n')
    } catch (err) {
      process.stdout.write('失败: ' + err.message.split('\n')[0] + '\n')
      if (err.stdout) process.stdout.write(String(err.stdout).trim() + '\n')
    }
  }
}
