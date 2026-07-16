'use strict';
// Foreground window + process detection with no native modules.
// On Windows it P/Invokes user32 via a short PowerShell script; elsewhere it degrades
// gracefully to nulls (the agent still tracks active/idle time).

const { exec } = require('child_process');
const os = require('os');

const PS = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class W {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
}
"@
$h = [W]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[void][W]::GetWindowText($h, $sb, 512)
$pid2 = 0
[void][W]::GetWindowThreadProcessId($h, [ref]$pid2)
$p = Get-Process -Id $pid2 -ErrorAction SilentlyContinue
$name = if ($p) { $p.ProcessName + '.exe' } else { '' }
Write-Output ($name + '|' + $sb.ToString())
`;

function getActiveWindow() {
  return new Promise((resolve) => {
    if (os.platform() !== 'win32') {
      resolve({ app: null, title: null });
      return;
    }
    exec(
      'powershell -NoProfile -NonInteractive -Command -',
      { timeout: 4000, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) { resolve({ app: null, title: null }); return; }
        const line = stdout.trim();
        const i = line.indexOf('|');
        const app = i >= 0 ? line.slice(0, i).trim() : null;
        const title = i >= 0 ? line.slice(i + 1).trim() : null;
        resolve({ app: app || null, title: title || null });
      }
    ).stdin.end(PS);
  });
}

module.exports = { getActiveWindow };
