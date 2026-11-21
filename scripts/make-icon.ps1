# ============================================================
# GitMate 图标生成脚本
# 生成：build/icon-*.png + build/icon.ico + build/icon.svg
# 设计：紫色渐变圆角方块 + 白色 Git 分支图形（两节点一弧线一主干）
# ============================================================
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot   # D:\GitMate
$buildDir = Join-Path $root 'build'
New-Item -ItemType Directory -Force -Path $buildDir | Out-Null

# --- 渐变色 ---
$c1 = [System.Drawing.Color]::FromArgb(255, 139, 124, 255)  # #8B7CFF 亮紫
$c2 = [System.Drawing.Color]::FromArgb(255, 84, 66, 235)    # #5442EB 深紫

function New-RoundRectPath([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = 2 * $r
  $p.AddArc($x, $y, $d, $d, 180, 90) | Out-Null
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90) | Out-Null
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90) | Out-Null
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90) | Out-Null
  $p.CloseFigure()
  return $p
}

function New-IconBitmap([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $s = $size / 256.0

  # 背景圆角方块（对角渐变）
  $rectF = New-Object System.Drawing.RectangleF(0, 0, $size, $size)
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rectF, $c1, $c2, 38.0)
  $bgPath = New-RoundRectPath 0 0 $size $size (58 * $s)
  $g.FillPath($brush, $bgPath) | Out-Null

  # 白色描边笔（圆头）
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, (15.0 * $s))
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round

  # 主干：左侧竖线
  $g.DrawLine($pen, (88 * $s), (96 * $s), (88 * $s), (204 * $s)) | Out-Null

  # 分支弧线：从左上节点弯到右上节点
  $curve = New-Object System.Drawing.Drawing2D.GraphicsPath
  $curve.AddBezier(
    (88 * $s), (92 * $s),
    (112 * $s), (34 * $s),
    (148 * $s), (34 * $s),
    (172 * $s), (92 * $s)) | Out-Null
  $g.DrawPath($pen, $curve) | Out-Null

  # 三个节点（实心白圆）
  $wb = [System.Drawing.Brushes]::White
  foreach ($pt in @(@(88, 92), @(88, 208), @(172, 92))) {
    $cx = $pt[0] * $s; $cy = $pt[1] * $s; $rad = 24 * $s
    $g.FillEllipse($wb, ($cx - $rad), ($cy - $rad), (2 * $rad), (2 * $rad)) | Out-Null
  }

  $g.Dispose()
  return $bmp
}

# --- 生成各尺寸 PNG ---
$sizes = @(256, 128, 64, 48, 32, 16)
$pngData = @()
foreach ($sz in $sizes) {
  $bmp = New-IconBitmap $sz
  $pngPath = Join-Path $buildDir ("icon-{0}.png" -f $sz)
  $bmp.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = [System.IO.File]::ReadAllBytes($pngPath)
  $pngData += , @{ Size = $sz; Bytes = $bytes }
  $bmp.Dispose()
  Write-Host ("  PNG {0}x{0}  {1} KB" -f $sz, [math]::Round($bytes.Length / 1KB, 1))
}

# --- 组装 .ico（Vista+ 支持 PNG 直嵌）---
$icoPath = Join-Path $buildDir 'icon.ico'
$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)
$bw.Write([uint16]0)                    # reserved
$bw.Write([uint16]1)                    # type: icon
$bw.Write([uint16]$pngData.Count)       # count
$offset = 6 + 16 * $pngData.Count
foreach ($p in $pngData) {
  $sz = $p.Size
  if ($sz -eq 256) { $bw.Write([byte]0) } else { $bw.Write([byte]$sz) }
  if ($sz -eq 256) { $bw.Write([byte]0) } else { $bw.Write([byte]$sz) }  # height（256 同样写 0）
  $bw.Write([byte]0)                    # palette
  $bw.Write([byte]0)                    # reserved
  $bw.Write([uint16]1)                  # planes
  $bw.Write([uint16]32)                 # bpp
  $bw.Write([uint32]$p.Bytes.Length)    # data size
  $bw.Write([uint32]$offset)            # data offset
  $offset += $p.Bytes.Length
}
foreach ($p in $pngData) { $bw.Write($p.Bytes) }
$bw.Flush()
[System.IO.File]::WriteAllBytes($icoPath, $ms.ToArray())
$bw.Dispose(); $ms.Dispose()
Write-Host ("  ICO  {0}" -f $icoPath)

# --- 同步保存一份 SVG 源文件（方便以后改设计）---
$svg = @'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1" gradientTransform="rotate(38 .5 .5)">
      <stop offset="0" stop-color="#8B7CFF"/>
      <stop offset="1" stop-color="#5442EB"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="256" height="256" rx="58" fill="url(#bg)"/>
  <g stroke="#FFFFFF" stroke-width="15" stroke-linecap="round" fill="none">
    <line x1="88" y1="96" x2="88" y2="204"/>
    <path d="M88 92 C112 34 148 34 172 92"/>
  </g>
  <circle cx="88"  cy="92"  r="24" fill="#FFFFFF"/>
  <circle cx="88"  cy="208" r="24" fill="#FFFFFF"/>
  <circle cx="172" cy="92"  r="24" fill="#FFFFFF"/>
</svg>
'@
[System.IO.File]::WriteAllText((Join-Path $buildDir 'icon.svg'), $svg)
Write-Host '图标生成完成 ✔'
