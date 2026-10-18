# Redline hotkey: Ctrl+Alt+Shift+R starts a capture from anywhere.
# Uses RegisterHotKey (a normal Windows hotkey, not a keyboard hook: it never sees other keys).
# One copy at a time (named mutex); started by the Redline mod, quits if the hotkey is taken.
param(
  [Parameter(Mandatory = $true)][string]$Node,
  [Parameter(Mandatory = $true)][string]$Helper
)
$ErrorActionPreference = 'Stop'
$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\RedlineHotkey', [ref]$created)
if (-not $created) { exit 0 }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public class RedlineHotkey : NativeWindow, IDisposable {
  [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr h, int id, uint mods, uint vk);
  [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr h, int id);
  const uint MOD_ALT = 1, MOD_CONTROL = 2, MOD_SHIFT = 4, MOD_NOREPEAT = 0x4000, VK_R = 0x52;
  readonly string node, helper;
  public bool Ok;
  public RedlineHotkey(string node, string helper) {
    this.node = node; this.helper = helper;
    CreateHandle(new CreateParams());
    Ok = RegisterHotKey(Handle, 1, MOD_CONTROL | MOD_ALT | MOD_SHIFT | MOD_NOREPEAT, VK_R);
  }
  protected override void WndProc(ref Message m) {
    if (m.Msg == 0x0312) { // WM_HOTKEY
      var psi = new ProcessStartInfo(node, "\"" + helper + "\" capture") { UseShellExecute = false, CreateNoWindow = true };
      try { Process.Start(psi); } catch { }
    }
    base.WndProc(ref m);
  }
  public void Dispose() { UnregisterHotKey(Handle, 1); DestroyHandle(); }
}
'@
$hk = New-Object RedlineHotkey $Node, $Helper
if (-not $hk.Ok) { exit 3 } # someone else owns Ctrl+Alt+Shift+R
[System.Windows.Forms.Application]::Run()
