# ReelHeist geliştirici native host kaydı (spec §5c).
# Kullanım:
#   powershell -ExecutionPolicy Bypass -File tools\dev-register.ps1           # Depodaki helper/ + sistem Node ile kaydet
#   powershell -ExecutionPolicy Bypass -File tools\dev-register.ps1 -Release  # Kurulu sürüme (%LOCALAPPDATA%\ReelHeist\app\host.cmd) dön
param(
    [switch]$Release
)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$helper = Join-Path $root 'helper'
$data = Join-Path $env:LOCALAPPDATA 'ReelHeist'
$hostName = 'com.reelheist.helper'
$legacyHost = 'com.dizi_indirici.helper'
$legacyData = Join-Path $env:LOCALAPPDATA 'DiziIndirici'
$extId = (Get-Content (Join-Path $root 'keys\extension-id.txt') -Raw).Trim()

New-Item -ItemType Directory -Force $data | Out-Null

if ($Release) {
    $hostPath = Join-Path $data 'app\host.cmd'
    if (-not (Test-Path $hostPath)) {
        throw "Kurulu sürüm bulunamadı: $hostPath"
    }
} else {
    # 1. Node.js
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) { throw 'Node.js bulunamadı. https://nodejs.org adresinden kurun ve tekrar çalıştırın.' }
    Write-Host "Node.js: $node"

    # 1b. Eski DiziIndirici klasöründen bir kerelik taşıma
    & $node (Join-Path $helper 'migrate.js')
    if ($LASTEXITCODE -ne 0) { throw 'Eski veriden taşıma başarısız.' }

    # 2. ffmpeg
    $ffmpegDir = Join-Path $data 'ffmpeg'
    $ffmpegExe = Join-Path $ffmpegDir 'bin\ffmpeg.exe'
    if (-not (Test-Path $ffmpegExe)) {
        $zip = Join-Path $env:TEMP 'reelheist-ffmpeg.zip'
        $url = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip'
        Write-Host "ffmpeg indiriliyor: $url"
        & curl.exe -L --ssl-no-revoke --fail -o $zip $url
        if ($LASTEXITCODE -ne 0) { throw 'ffmpeg indirilemedi.' }
        $tmp = Join-Path $env:TEMP 'reelheist-ffmpeg'
        if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
        Expand-Archive -Path $zip -DestinationPath $tmp
        $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
        if (Test-Path $ffmpegDir) { Remove-Item -Recurse -Force $ffmpegDir }
        Move-Item $inner.FullName $ffmpegDir
        Remove-Item -Recurse -Force $tmp
        Remove-Item -Force $zip
    }
    Write-Host "ffmpeg: $ffmpegExe"

    # 2b. yt-dlp
    $ytDir = Join-Path $data 'yt-dlp'
    $ytExe = Join-Path $ytDir 'yt-dlp.exe'
    if (-not (Test-Path $ytExe)) {
        New-Item -ItemType Directory -Force $ytDir | Out-Null
        Write-Host 'yt-dlp indiriliyor'
        & curl.exe -L --ssl-no-revoke --fail -o $ytExe 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
        if ($LASTEXITCODE -ne 0) { throw 'yt-dlp indirilemedi.' }
    }
    Write-Host "yt-dlp: $ytExe"

    # 3. Host başlatıcı (geliştirici)
    $bat = Join-Path $helper 'host.bat'
    Set-Content -Path $bat -Encoding ASCII -Value "@echo off`r`n`"$node`" `"%~dp0host.js`" %*"
    $hostPath = $bat
}

# 4. Host manifest (BOM olmadan)
$manifestPath = Join-Path $data "$hostName.json"
$manifest = [ordered]@{
    name            = $hostName
    description     = 'ReelHeist helper'
    path            = $hostPath
    type            = 'stdio'
    allowed_origins = @("chrome-extension://$extId/")
}
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json), (New-Object System.Text.UTF8Encoding $false))

# 5. Tarayıcı kayıtları (Chrome, Brave, Edge, Chromium)
$keys = @(
    'HKCU:\Software\Google\Chrome\NativeMessagingHosts',
    'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts',
    'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts',
    'HKCU:\Software\Chromium\NativeMessagingHosts'
)
foreach ($k in $keys) {
    Remove-Item -Path (Join-Path $k $legacyHost) -Force -ErrorAction SilentlyContinue
    $path = Join-Path $k $hostName
    New-Item -Path $path -Force | Out-Null
    Set-ItemProperty -Path $path -Name '(default)' -Value $manifestPath
}
Remove-Item -Force (Join-Path $legacyData "$legacyHost.json") -ErrorAction SilentlyContinue

$mode = if ($Release) { 'Release' } else { 'Dev' }
Write-Host "Native host kaydedildi ($mode): $hostPath"
