# Foxpit build (Windows). Run from anywhere: powershell -File build.ps1
# Makes dist\foxpit.exe, and with -Setup also dist\FoxpitSetup-<version>.exe
# (+ .sha256) for a release. The version is the VERSION file.
param([switch]$Setup)
$ErrorActionPreference = 'Stop'
$env:PATH = "C:\Program Files\Go\bin;$env:PATH"
Set-Location $PSScriptRoot
$v = (Get-Content VERSION -Raw).Trim()
$winres = 'github.com/tc-hib/go-winres@v0.3.3'
Push-Location build
go run $winres make --in winres.json --arch amd64 --out ..\rsrc --product-version $v --file-version $v
Pop-Location
$env:CGO_ENABLED = '0'
go build -trimpath -ldflags="-s -w -H windowsgui -X main.version=$v" -o dist/foxpit.exe .
$code = $LASTEXITCODE
Remove-Item rsrc_windows_*.syso -ErrorAction SilentlyContinue
if ($code -ne 0) { exit $code }
"foxpit.exe $v " + [math]::Round((Get-Item dist\foxpit.exe).Length / 1MB, 1) + " MB"
if (-not $Setup) { exit 0 }

# the installer carries foxpit.exe and Magpie (MIT, yetone/magpie) inside it
$mpv = (Get-Content MAGPIE_VERSION -Raw).Trim()
$mpd = "dist\magpie-$mpv"
if (-not (Test-Path "$mpd\magpie.exe")) {
  New-Item -ItemType Directory -Force $mpd | Out-Null
  gh release download $mpv -R yetone/magpie -p 'magpie-windows-amd64.exe' -p 'SHA256SUMS' -D $mpd --clobber
  if ($LASTEXITCODE -ne 0) { throw "could not download Magpie $mpv" }
  $want = (((Get-Content "$mpd\SHA256SUMS") | Where-Object { $_ -match 'magpie-windows-amd64\.exe$' }) -split '\s+')[0]
  $got = (Get-FileHash "$mpd\magpie-windows-amd64.exe" -Algorithm SHA256).Hash.ToLower()
  if (-not $want -or $want.ToLower() -ne $got) { Remove-Item "$mpd\magpie-windows-amd64.exe"; throw "Magpie $mpv checksum does not match" }
  Move-Item "$mpd\magpie-windows-amd64.exe" "$mpd\magpie.exe" -Force
}
New-Item -ItemType Directory -Force installer\payload | Out-Null
Copy-Item dist\foxpit.exe installer\payload\foxpit.exe -Force
Copy-Item "$mpd\magpie.exe" installer\payload\magpie.exe -Force
Push-Location installer
go run $winres make --in winres.json --arch amd64 --out rsrc --product-version $v --file-version $v
go build -trimpath -ldflags="-s -w -H windowsgui -X main.version=$v" -o "..\dist\FoxpitSetup-$v.exe" .
$code = $LASTEXITCODE
Remove-Item rsrc_windows_*.syso, payload\foxpit.exe, payload\magpie.exe -ErrorAction SilentlyContinue
Pop-Location
if ($code -ne 0) { exit $code }
$out = "dist\FoxpitSetup-$v.exe"
$sum = (Get-FileHash $out -Algorithm SHA256).Hash.ToLower()
[IO.File]::WriteAllText("$PWD\$out.sha256", "$sum  FoxpitSetup-$v.exe`n")
"FoxpitSetup-$v.exe " + [math]::Round((Get-Item $out).Length / 1MB, 1) + " MB  sha256 $sum"
