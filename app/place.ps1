# Redline: turns the editor's Edge window into a borderless, topmost sheet exactly over one monitor
# (physical pixels), so it looks like you are drawing on the frozen screen itself.
# -Title  the window title to wait for   -X -Y -W -H  the monitor, in virtual-screen pixels
# -Focus  only bring an already placed window to the front (after the frozen overlay steps aside)
# -Close  close the window (after Send / Cancel)
# -Maximize  bring the window up maximized (Redline Text)
# -Fullscreen  move the window onto the monitor and make it Edge-fullscreen there (F11), unless it already is
param(
  [Parameter(Mandatory = $true)][string]$Title,
  [int]$X, [int]$Y, [int]$W, [int]$H,
  [switch]$Focus,
  [switch]$Close,
  [switch]$Fullscreen,
  [switch]$Maximize,
  [int]$TimeoutMs = 15000
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class RedlineWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetLong(IntPtr h, int i);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetLong(IntPtr h, int i, IntPtr v);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint f);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);

  public static bool Covers(IntPtr h, int x, int y, int w, int hh) {
    RECT r; GetWindowRect(h, out r);
    return r.L <= x && r.T <= y && r.R >= x + w && r.B >= y + hh;
  }
  public static void FullscreenOn(IntPtr h, int x, int y, int w, int hh) {
    if (Covers(h, x, y, w, hh)) { Front(h); return; }      // already fullscreen there (a cold Edge honours --start-fullscreen)
    ShowWindow(h, 9);                                        // SW_RESTORE
    SetWindowPos(h, IntPtr.Zero, x + 80, y + 80, Math.Min(900, w - 160), Math.Min(700, hh - 160), 0x0040); // onto that monitor
    System.Threading.Thread.Sleep(120);
    Front(h);
    System.Threading.Thread.Sleep(80);
    keybd_event(0x7A, 0, 0, UIntPtr.Zero); keybd_event(0x7A, 0, 2, UIntPtr.Zero); // F11: Edge's own fullscreen on the monitor it is on
  }
  public static void Max(IntPtr h) { ShowWindow(h, 3); } // SW_MAXIMIZE
  public static IntPtr Find(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
      if (sb.ToString().StartsWith(title)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int L, T, R, B; }
  public static string Sheet(IntPtr h, int x, int y, int w, int hh) {
    const int GWL_STYLE = -16; const long WS_POPUP = 0x80000000L, WS_VISIBLE = 0x10000000L, WS_CLIPCHILDREN = 0x02000000L, WS_CLIPSIBLINGS = 0x04000000L;
    ShowWindow(h, 9); // SW_RESTORE: out of any maximized state first
    SetLong(h, GWL_STYLE, new IntPtr(WS_POPUP | WS_VISIBLE | WS_CLIPCHILDREN | WS_CLIPSIBLINGS));
    RECT r = new RECT();
    for (int i = 0; i < 6; i++) {
      // HWND_TOPMOST, SWP_FRAMECHANGED | SWP_SHOWWINDOW | SWP_NOOWNERZORDER
      SetWindowPos(h, new IntPtr(-1), x, y, w, hh, 0x0020 | 0x0040 | 0x0200);
      System.Threading.Thread.Sleep(60);
      GetWindowRect(h, out r);
      if (r.L == x && r.T == y && r.R - r.L == w && r.B - r.T == hh) break;
    }
    return r.L + "," + r.T + "," + (r.R - r.L) + "x" + (r.B - r.T);
  }
  public static void Front(IntPtr h) {
    ShowWindow(h, 5);
    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero); // a tap of Alt lets us take the foreground
    SetForegroundWindow(h);
  }
}
'@
[void][RedlineWin]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))

if ($Close) { $TimeoutMs = 1500 }
$waited = 0; $h = [IntPtr]::Zero
while ($waited -lt $TimeoutMs) {
  $h = [RedlineWin]::Find($Title)
  if ($h -ne [IntPtr]::Zero) { break }
  Start-Sleep -Milliseconds 60; $waited += 60
}
if ($h -eq [IntPtr]::Zero) { exit 3 }
if ($Close) { [void][RedlineWin]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero); exit 0 } # WM_CLOSE
if ($Maximize) { [RedlineWin]::Front($h); [RedlineWin]::Max($h); exit 0 }
if ($Fullscreen) { [RedlineWin]::FullscreenOn($h, $X, $Y, $W, $H); exit 0 }
if (-not $Focus) { Write-Output ([RedlineWin]::Sheet($h, $X, $Y, $W, $H)) }
[RedlineWin]::Front($h)
exit 0
