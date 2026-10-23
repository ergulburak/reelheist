# ReelHeist kaldırma: host kayıtlarını siler, yardımcıyı durdurur.
# ffmpeg ve indirilen videolar silinmez.
$hostName = 'com.reelheist.helper'
$legacyHost = 'com.dizi_indirici.helper'
$data = Join-Path $env:LOCALAPPDATA 'ReelHeist'
$legacyData = Join-Path $env:LOCALAPPDATA 'DiziIndirici'

$info = Join-Path $data 'daemon.json'
if (Test-Path $info) {
    $d = Get-Content $info -Raw | ConvertFrom-Json
    Stop-Process -Id $d.pid -Force -ErrorAction SilentlyContinue
}

foreach ($k in @(
    'HKCU:\Software\Google\Chrome\NativeMessagingHosts',
    'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts',
    'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts',
    'HKCU:\Software\Chromium\NativeMessagingHosts')) {
    Remove-Item -Path (Join-Path $k $hostName) -Force -ErrorAction SilentlyContinue
    Remove-Item -Path (Join-Path $k $legacyHost) -Force -ErrorAction SilentlyContinue
}
Remove-Item -Force (Join-Path $data "$hostName.json") -ErrorAction SilentlyContinue
Remove-Item -Force (Join-Path $legacyData "$legacyHost.json") -ErrorAction SilentlyContinue
Write-Host 'Kayıtlar silindi. Eklentiyi tarayıcının eklenti sayfasından kaldırın.'
