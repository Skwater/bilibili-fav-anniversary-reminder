param(
  [string]$AssetsDir = (Join-Path $PSScriptRoot '..\assets')
)

Add-Type -AssemblyName System.Drawing

$assets = [IO.Path]::GetFullPath($AssetsDir)
$backgroundPath = Join-Path $assets 'promo-background.png'

function New-RoundedPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $path = [Drawing.Drawing2D.GraphicsPath]::new()
  $d = $r * 2
  $path.AddArc($x, $y, $d, $d, 180, 90)
  $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

function Draw-Pill($graphics, [string]$text, [float]$x, [float]$y, [float]$w) {
  $path = New-RoundedPath $x $y $w 42 21
  $fill = [Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(205, 255, 255, 255))
  $border = [Drawing.Pen]::new([Drawing.Color]::FromArgb(65, 0, 161, 214), 1)
  $font = [Drawing.Font]::new('Microsoft YaHei UI', 15, [Drawing.FontStyle]::Regular, [Drawing.GraphicsUnit]::Pixel)
  $brush = [Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(255, 42, 69, 83))
  $format = [Drawing.StringFormat]::new()
  $format.Alignment = [Drawing.StringAlignment]::Center
  $format.LineAlignment = [Drawing.StringAlignment]::Center
  try {
    $graphics.FillPath($fill, $path)
    $graphics.DrawPath($border, $path)
    $graphics.DrawString($text, $font, $brush, [Drawing.RectangleF]::new($x, $y, $w, 42), $format)
  } finally {
    $format.Dispose(); $brush.Dispose(); $font.Dispose(); $border.Dispose(); $fill.Dispose(); $path.Dispose()
  }
}

function New-Promo([string]$sourceName, [string]$outputName, [string]$headline, [string]$subtitle, [string[]]$pills) {
  $sourcePath = Join-Path $assets $sourceName
  $outputPath = Join-Path $assets $outputName
  $canvas = [Drawing.Bitmap]::new(1280, 800, [Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $canvas.SetResolution(96, 96)
  $graphics = [Drawing.Graphics]::FromImage($canvas)
  $background = [Drawing.Image]::FromFile($backgroundPath)
  $source = [Drawing.Image]::FromFile($sourcePath)
  try {
    $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.TextRenderingHint = [Drawing.Text.TextRenderingHint]::ClearTypeGridFit
    $graphics.Clear([Drawing.Color]::White)

    # Cover-crop the generated backdrop, then soften it with a white veil for UI readability.
    $scale = [Math]::Max(1280 / $background.Width, 800 / $background.Height)
    $drawW = [float]($background.Width * $scale)
    $drawH = [float]($background.Height * $scale)
    $graphics.DrawImage($background, [Drawing.RectangleF]::new((1280 - $drawW) / 2, (800 - $drawH) / 2, $drawW, $drawH))
    $veil = [Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(40, 255, 255, 255))
    $graphics.FillRectangle($veil, 0, 0, 1280, 800)
    $veil.Dispose()

    # Left-side marketing copy.
    $accent = [Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(255, 0, 161, 214))
    $dark = [Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(255, 24, 25, 28))
    $muted = [Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(255, 80, 91, 103))
    $brandFont = [Drawing.Font]::new('Microsoft YaHei UI', 24, [Drawing.FontStyle]::Bold, [Drawing.GraphicsUnit]::Pixel)
    $headlineFont = [Drawing.Font]::new('Microsoft YaHei UI', 48, [Drawing.FontStyle]::Bold, [Drawing.GraphicsUnit]::Pixel)
    $subtitleFont = [Drawing.Font]::new('Microsoft YaHei UI', 22, [Drawing.FontStyle]::Regular, [Drawing.GraphicsUnit]::Pixel)
    $footFont = [Drawing.Font]::new('Microsoft YaHei UI', 16, [Drawing.FontStyle]::Regular, [Drawing.GraphicsUnit]::Pixel)
    try {
      $graphics.FillEllipse($accent, 72, 69, 42, 42)
      $markFont = [Drawing.Font]::new('Microsoft YaHei UI', 23, [Drawing.FontStyle]::Bold, [Drawing.GraphicsUnit]::Pixel)
      $markBrush = [Drawing.SolidBrush]::new([Drawing.Color]::White)
      try { $graphics.DrawString('拾', $markFont, $markBrush, 78, 74) } finally { $markBrush.Dispose(); $markFont.Dispose() }
      $graphics.DrawString('哔哩朝花夕拾', $brandFont, $dark, 128, 74)
      $graphics.DrawString($headline, $headlineFont, $dark, [Drawing.RectangleF]::new(72, 187, 600, 145))
      $graphics.DrawString($subtitle, $subtitleFont, $muted, [Drawing.RectangleF]::new(76, 350, 560, 78))

      $x = 76
      foreach ($pill in $pills) {
        $w = 46 + ($pill.Length * 18)
        Draw-Pill $graphics $pill $x 464 $w
        $x += $w + 14
      }
      $graphics.DrawString('Chrome 扩展  ·  数据仅存本机', $footFont, $muted, 76, 706)
    } finally {
      $footFont.Dispose(); $subtitleFont.Dispose(); $headlineFont.Dispose(); $brandFont.Dispose()
      $muted.Dispose(); $dark.Dispose(); $accent.Dispose()
    }

    # Preserve the original screenshot at 1:1 pixels inside a clean product card.
    $shotX = 730
    $shotY = [float]((800 - $source.Height) / 2)
    $cardX = $shotX - 14
    $cardY = $shotY - 14
    $cardW = $source.Width + 28
    $cardH = $source.Height + 28
    $shadowPath = New-RoundedPath ($cardX + 8) ($cardY + 10) $cardW $cardH 18
    $cardPath = New-RoundedPath $cardX $cardY $cardW $cardH 18
    $shadow = [Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(42, 28, 61, 78))
    $white = [Drawing.SolidBrush]::new([Drawing.Color]::White)
    $border = [Drawing.Pen]::new([Drawing.Color]::FromArgb(45, 67, 85, 96), 1)
    try {
      $graphics.FillPath($shadow, $shadowPath)
      $graphics.FillPath($white, $cardPath)
      $graphics.DrawPath($border, $cardPath)
      $graphics.DrawImageUnscaled($source, [int]$shotX, [int]$shotY)
    } finally {
      $border.Dispose(); $white.Dispose(); $shadow.Dispose(); $cardPath.Dispose(); $shadowPath.Dispose()
    }

    $canvas.Save($outputPath, [Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $source.Dispose(); $background.Dispose(); $graphics.Dispose(); $canvas.Dispose()
  }
  Write-Output $outputPath
}

New-Promo 'PixPin_2026-09-17_19-57-32.png' 'screenshot-2.png' "今天，也能遇见`n多年前的喜欢" '按投稿日期，唤醒收藏夹里的“历史上的今天”' @('今日命中', '一键回看', '隐私友好')
New-Promo 'PixPin_2026-09-17_19-57-41.png' 'screenshot-3.png' "把收藏记忆，`n翻成一页日历" '历史日历，让每一天都有旧时光' @('历史日历', '任意日期', '跨年回忆')
