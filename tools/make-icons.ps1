<#
  Splanner 앱 아이콘 만들기

  사용법
    내 아이콘으로:  pwsh tools/make-icons.ps1 -Source "C:\경로\내아이콘.png"
    임시 아이콘:    pwsh tools/make-icons.ps1

  정사각형이 아니면 가운데를 정사각형으로 잘라 쓴다. 1024px 이상 PNG를 추천.
  만들어지는 파일 (assets/icons/)
    apple-touch-icon.png   180  아이패드 홈 화면
    icon-192.png           192
    icon-512.png           512
    icon-maskable-512.png  512  안드로이드용 (가장자리 여백 포함)
#>
param([string]$Source)

Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = "Stop"
$outDir = Join-Path $PSScriptRoot "..\assets\icons"
New-Item -ItemType Directory -Force $outDir | Out-Null

function New-Canvas([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = "AntiAlias"
  $g.InterpolationMode = "HighQualityBicubic"
  $g.PixelOffsetMode = "HighQuality"
  return @($bmp, $g)
}

# ---------- 임시 아이콘: 크림색 종이 위의 별 ----------
function Draw-Placeholder($g, [int]$size, [double]$inset) {
  $g.Clear([System.Drawing.ColorTranslator]::FromHtml("#fbf8f3"))
  $cx = $size / 2; $cy = $size / 2 + $size * 0.02
  # PowerShell 변수는 대소문자를 구분하지 않으므로 이름을 따로 짓는다
  $outerR = $size * (0.30 - $inset * 0.3); $innerR = $outerR * 0.45
  $pts = New-Object 'System.Drawing.PointF[]' 10
  for ($i = 0; $i -lt 10; $i++) {
    $rad = if ($i % 2 -eq 0) { $outerR } else { $innerR }
    $a = -[Math]::PI / 2 + $i * [Math]::PI / 5
    $pts[$i] = New-Object System.Drawing.PointF ([float]($cx + $rad * [Math]::Cos($a))), ([float]($cy + $rad * [Math]::Sin($a)))
  }
  $fill = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml("#f6e7a6"))
  $pen = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml("#5b544b")), ([float]($size * 0.022))
  $pen.LineJoin = "Round"
  $g.FillPolygon($fill, $pts)
  $g.DrawPolygon($pen, $pts)
  # 아래쪽 가는 선 (플래너 머리줄 느낌)
  $line = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml("#c9c2b6")), ([float]($size * 0.008))
  $y = $cy + $outerR + $size * 0.09
  $g.DrawLine($line, [float]($size * (0.22 + $inset)), [float]$y, [float]($size * (0.78 - $inset)), [float]$y)
}

# ---------- 내 아이콘: 가운데 정사각형으로 잘라 넣기 ----------
function Draw-Source($g, $img, [int]$size, [double]$inset) {
  $side = [Math]::Min($img.Width, $img.Height)
  $src = New-Object System.Drawing.Rectangle ([int](($img.Width - $side) / 2)), ([int](($img.Height - $side) / 2)), $side, $side
  if ($inset -gt 0) {
    # 여백은 원본 왼쪽 위 픽셀 색으로 채움
    $g.Clear(([System.Drawing.Bitmap]$img).GetPixel($src.X, $src.Y))
  }
  $pad = [int]($size * $inset)
  $dst = New-Object System.Drawing.Rectangle $pad, $pad, ($size - 2 * $pad), ($size - 2 * $pad)
  $g.DrawImage($img, $dst, $src, [System.Drawing.GraphicsUnit]::Pixel)
}

$img = $null
if ($Source) {
  if (-not (Test-Path $Source)) { throw "아이콘 파일을 찾을 수 없어요: $Source" }
  $img = New-Object System.Drawing.Bitmap (Resolve-Path $Source).Path
}

$targets = @(
  @{ name = "apple-touch-icon.png"; size = 180; inset = 0 },
  @{ name = "icon-192.png"; size = 192; inset = 0 },
  @{ name = "icon-512.png"; size = 512; inset = 0 },
  @{ name = "icon-maskable-512.png"; size = 512; inset = 0.1 }
)
foreach ($t in $targets) {
  $bmp, $g = New-Canvas $t.size
  if ($img) { Draw-Source $g $img $t.size $t.inset } else { Draw-Placeholder $g $t.size $t.inset }
  $path = Join-Path $outDir $t.name
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host "만듦: assets/icons/$($t.name) ($($t.size)px)"
}
if ($img) { $img.Dispose() }
