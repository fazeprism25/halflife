param([string]$Deck, [string]$OutDir, [string]$Only = "")
New-Item -ItemType Directory -Force $OutDir | Out-Null
$app = New-Object -ComObject PowerPoint.Application
try {
  $p = $app.Presentations.Open($Deck, $true, $false, $false)
  $n = $p.Slides.Count
  $want = @()
  if ($Only) { $want = $Only.Split(",") | ForEach-Object { [int]$_ } }
  for ($i = 1; $i -le $n; $i++) {
    if ($want.Count -gt 0 -and -not ($want -contains $i)) { continue }
    $f = Join-Path $OutDir ("slide-{0:D2}.png" -f $i)
    $p.Slides.Item($i).Export($f, "PNG", 1920, 1080)
  }
  $p.Close()
  "rendered $n slides"
} finally {
  $app.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) | Out-Null
}
