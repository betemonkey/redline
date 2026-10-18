# Redline region capture: freezes every monitor and lets you drag a box.
# Saves the whole monitor the box is on (the editor shows it as the frozen screen) and prints one JSON line:
#   {"screen":"<png>","monitor":{x,y,w,h},"sel":{x,y,w,h}}   (monitor in virtual-screen px, sel relative to the monitor)
# Then keeps the frozen screen up until the -Ready file exists (the editor is on screen), so nothing flickers.
# Exit 0 = selected, 2 = cancelled (Esc / right-click). -Rect "x,y,w,h" (virtual px) skips the overlay, for tests.
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Ready = '',
  [int]$HoldMs = 12000,
  [string]$Rect = '',
  [string]$AutoRect = ''   # tests: show the real overlay, then select this box (form px) by itself
)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RedlineDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern uint GetDpiForSystem();
  public static void PerMonitor() { SetProcessDpiAwarenessContext(new IntPtr(-4)); }
}
'@
# Physical pixels everywhere, so a 125% monitor is captured sharp.
[RedlineDpi]::PerMonitor()
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

# Virtual screen = all monitors together (SM_XVIRTUALSCREEN..SM_CYVIRTUALSCREEN).
$vx = [RedlineDpi]::GetSystemMetrics(76); $vy = [RedlineDpi]::GetSystemMetrics(77)
$vw = [RedlineDpi]::GetSystemMetrics(78); $vh = [RedlineDpi]::GetSystemMetrics(79)

$shot = New-Object System.Drawing.Bitmap $vw, $vh
$g = [System.Drawing.Graphics]::FromImage($shot)
$g.CopyFromScreen($vx, $vy, 0, 0, $shot.Size)
$g.Dispose()

# Saves the monitor under the box's centre; returns the JSON line (or $null when the box is too small).
function Save-Selection([int]$x, [int]$y, [int]$w, [int]$h) {
  $cx = $vx + $x + [int]($w / 2); $cy = $vy + $y + [int]($h / 2)
  $mon = [System.Windows.Forms.Screen]::FromPoint((New-Object System.Drawing.Point $cx, $cy)).Bounds
  $sx = [Math]::Max(0, $vx + $x - $mon.X); $sy = [Math]::Max(0, $vy + $y - $mon.Y)
  $sw = [Math]::Min($w, $mon.Width - $sx); $sh = [Math]::Min($h, $mon.Height - $sy)
  if ($sw -lt 8 -or $sh -lt 8) { return $null }
  $slice = $shot.Clone((New-Object System.Drawing.Rectangle ($mon.X - $vx), ($mon.Y - $vy), $mon.Width, $mon.Height), $shot.PixelFormat)
  $dir = Split-Path -Parent $Out
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
  $slice.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  $slice.Dispose()
  return (@{
    screen  = $Out
    monitor = @{ x = $mon.X; y = $mon.Y; w = $mon.Width; h = $mon.Height }
    sel     = @{ x = $sx; y = $sy; w = $sw; h = $sh }
    scale   = [RedlineDpi]::GetDpiForSystem() / 96.0
  } | ConvertTo-Json -Compress -Depth 4)
}

if ($Rect) {
  $p = $Rect.Split(',') | ForEach-Object { [int]$_ }
  $line = Save-Selection ($p[0] - $vx) ($p[1] - $vy) $p[2] $p[3]
  if ($line) { [Console]::Out.WriteLine($line); exit 0 } else { exit 2 }
}

# Dimmed copy of the frozen screen; the dragged box shows the real pixels.
$dim = New-Object System.Drawing.Bitmap $vw, $vh
$dg = [System.Drawing.Graphics]::FromImage($dim)
$dg.DrawImage($shot, 0, 0)
$veil = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(140, 5, 7, 10))
$dg.FillRectangle($veil, 0, 0, $vw, $vh)
$dg.Dispose()

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.AutoScaleMode = 'None'
$form.Bounds = New-Object System.Drawing.Rectangle $vx, $vy, $vw, $vh
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.Cursor = [System.Windows.Forms.Cursors]::Cross
$form.KeyPreview = $true
# Double-buffered painting so the box doesn't flicker while dragging.
$prop = [System.Windows.Forms.Control].GetProperty('DoubleBuffered', [System.Reflection.BindingFlags]'NonPublic,Instance')
$prop.SetValue($form, $true, $null)

$state = @{ down = $false; x0 = 0; y0 = 0; x1 = 0; y1 = 0; done = $false; waitedMs = 0 }
$accent = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 217, 119, 87)), 2
$hintFont = New-Object System.Drawing.Font 'Segoe UI', 11
$hintBg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(235, 27, 32, 40))
$hintInk = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 232, 236, 241))

function Get-Sel {
  $x = [Math]::Min($state.x0, $state.x1); $y = [Math]::Min($state.y0, $state.y1)
  return New-Object System.Drawing.Rectangle $x, $y, ([Math]::Abs($state.x1 - $state.x0)), ([Math]::Abs($state.y1 - $state.y0))
}

$form.Add_Paint({
  param($s, $e)
  $e.Graphics.DrawImage($dim, 0, 0)
  if ($state.down) {
    $r = Get-Sel
    if ($r.Width -gt 0 -and $r.Height -gt 0) {
      $e.Graphics.DrawImage($shot, $r, $r, [System.Drawing.GraphicsUnit]::Pixel)
      $e.Graphics.DrawRectangle($accent, $r)
      if (-not $state.done) {
        $label = "$($r.Width) x $($r.Height)"
        $e.Graphics.FillRectangle($hintBg, $r.X, [Math]::Max(0, $r.Y - 26), 110, 24)
        $e.Graphics.DrawString($label, $hintFont, $hintInk, $r.X + 6, [Math]::Max(0, $r.Y - 24))
      }
    }
  } else {
    # Hint on the monitor under the cursor.
    $pos = [System.Windows.Forms.Cursor]::Position
    $scr = [System.Windows.Forms.Screen]::FromPoint($pos).Bounds
    $hx = $scr.X - $vx + [int](($scr.Width - 470) / 2); $hy = $scr.Y - $vy + 40
    $e.Graphics.FillRectangle($hintBg, $hx, $hy, 470, 34)
    $e.Graphics.DrawString('Redline: drag a box around what you want to mark  -  Esc to cancel', $hintFont, $hintInk, $hx + 12, $hy + 7)
  }
})
$form.Add_MouseDown({
  param($s, $e)
  if ($state.done) { return }
  if ($e.Button -eq 'Right') { $form.Close(); return }
  $state.down = $true; $state.x0 = $e.X; $state.y0 = $e.Y; $state.x1 = $e.X; $state.y1 = $e.Y
})
$form.Add_MouseMove({
  param($s, $e)
  if ($state.down -and -not $state.done) { $state.x1 = $e.X; $state.y1 = $e.Y; $form.Invalidate() }
})

# After the box: stay up (frozen) until the editor says it is on screen, then step aside.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 80
$timer.Add_Tick({
  $state.waitedMs += $timer.Interval
  if (($Ready -and (Test-Path $Ready)) -or $state.waitedMs -ge $HoldMs) { $timer.Stop(); $form.Close() }
})

$form.Add_MouseUp({
  param($s, $e)
  if (-not $state.down -or $state.done) { return }
  $state.x1 = $e.X; $state.y1 = $e.Y
  $r = Get-Sel
  if ($r.Width -lt 8 -or $r.Height -lt 8) { $state.down = $false; $form.Invalidate(); return }
  $line = Save-Selection $r.X $r.Y $r.Width $r.Height
  if (-not $line) { $state.down = $false; $form.Invalidate(); return }
  $state.done = $true
  [Console]::Out.WriteLine($line); [Console]::Out.Flush()
  $form.Cursor = [System.Windows.Forms.Cursors]::WaitCursor
  $form.Invalidate()
  if ($Ready) { $timer.Start() } else { $form.Close() }
})
$form.Add_KeyDown({ param($s, $e) if ($e.KeyCode -eq 'Escape' -and -not $state.done) { $form.Close() } })
$form.Add_Shown({ $form.Activate() })
if ($AutoRect) {
  $auto = New-Object System.Windows.Forms.Timer; $auto.Interval = 600
  $auto.Add_Tick({
    $auto.Stop(); $p = $AutoRect.Split(',') | ForEach-Object { [int]$_ }
    $state.down = $true; $state.x0 = $p[0]; $state.y0 = $p[1]; $state.x1 = $p[0] + $p[2]; $state.y1 = $p[1] + $p[3]
    $line = Save-Selection $p[0] $p[1] $p[2] $p[3]; $state.done = $true
    [Console]::Out.WriteLine($line); [Console]::Out.Flush()
    $form.Cursor = [System.Windows.Forms.Cursors]::WaitCursor; $form.Invalidate()
    if ($Ready) { $timer.Start() } else { $form.Close() }
  })
  $auto.Start()
}

[System.Windows.Forms.Application]::Run($form)
if ($state.done) { exit 0 } else { exit 2 }
