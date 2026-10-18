# Redline OCR: reads the words under each marked region with Windows' built-in OCR (no download).
# -Image  the original capture (full resolution)
# -Regions JSON file: [{ "id": "...", "x": 0, "y": 0, "w": 100, "h": 20 }, ...] in image pixels
# Prints JSON: [{ "id": "...", "text": "..." }, ...]
param(
  [Parameter(Mandatory = $true)][string]$Image,
  [Parameter(Mandatory = $true)][string]$Regions
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing, System.Runtime.WindowsRuntime

[void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
[void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
[void][Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]

# PowerShell 5.1 has no await: turn a WinRT IAsyncOperation into a Task and wait on it.
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } |
  Select-Object -First 1
function Await($op, [Type]$type) {
  $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $t.Wait(-1) | Out-Null
  return $t.Result
}

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('en-US')) }

$src = [System.Drawing.Bitmap]::FromFile($Image)
$list = Get-Content -Raw -Encoding UTF8 $Regions | ConvertFrom-Json
$out = @()
foreach ($r in @($list)) {
  $x = [Math]::Max(0, [int]$r.x); $y = [Math]::Max(0, [int]$r.y)
  $w = [Math]::Min([int]$r.w, $src.Width - $x); $h = [Math]::Min([int]$r.h, $src.Height - $y)
  if ($w -lt 4 -or $h -lt 4) { $out += @{ id = $r.id; text = '' }; continue }
  # Small UI text reads far better at 2x.
  $scale = if ($h -lt 120) { 2 } else { 1 }
  $bmp = New-Object System.Drawing.Bitmap ($w * $scale), ($h * $scale)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($src, (New-Object System.Drawing.Rectangle 0, 0, ($w * $scale), ($h * $scale)), (New-Object System.Drawing.Rectangle $x, $y, $w, $h), [System.Drawing.GraphicsUnit]::Pixel)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  $ras = [Windows.Storage.Streams.InMemoryRandomAccessStream]::new()
  $writer = [Windows.Storage.Streams.DataWriter]::new($ras)
  $writer.WriteBytes($ms.ToArray())
  Await ($writer.StoreAsync()) ([UInt32]) | Out-Null
  $ras.Seek(0)
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($ras)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $soft = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $res = Await ($engine.RecognizeAsync($soft)) ([Windows.Media.Ocr.OcrResult])
  $text = (@($res.Lines) | ForEach-Object { $_.Text }) -join "`n"
  $out += @{ id = $r.id; text = $text }
}
$src.Dispose()
# Force a JSON array even for one region, UTF-8 out.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Write-Output (ConvertTo-Json -InputObject @($out) -Compress)
