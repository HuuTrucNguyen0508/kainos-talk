# Starts the packaged Windows app on a new profile and checks it comes up: the process stays
# running, and it opens the dock page and, on a first launch, Choose your apps. Run from desktop/.
$ErrorActionPreference = 'Stop'
$exe = Join-Path $PWD 'release\win-unpacked\kainos-talk.exe'
$env:KAINOS_USER_DATA = Join-Path $env:RUNNER_TEMP 'kainos-launch-check'
$env:KAINOS_BLOCK_EXTERNAL = '1'
$env:KAINOS_SYNC_MDNS = '0'
$port = 9333
$app = Start-Process -FilePath $exe -ArgumentList "--remote-debugging-port=$port" -PassThru
$pages = @()
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 1
  if ($app.HasExited) { throw "Kainos Talk exited during startup with code $($app.ExitCode)" }
  try { $pages = @(Invoke-RestMethod "http://127.0.0.1:$port/json/list") } catch { continue }
  $urls = $pages | ForEach-Object { $_.url }
  if (($urls -match 'renderer/index\.html') -and ($urls -match 'renderer/apps\.html')) { break }
}
$urls = $pages | ForEach-Object { $_.url }
Write-Host "Pages:"; $urls | ForEach-Object { Write-Host "  $_" }
if (-not ($urls -match 'renderer/index\.html')) { throw 'The dock page never opened' }
if (-not ($urls -match 'renderer/apps\.html')) { throw 'Choose your apps never opened on a first launch' }
Start-Sleep -Seconds 10
if ($app.HasExited) { throw "Kainos Talk exited after startup with code $($app.ExitCode)" }
if (-not (Test-Path (Join-Path $env:KAINOS_USER_DATA 'sms-sync')) -and (Get-ChildItem $env:KAINOS_USER_DATA).Count -eq 0) { throw 'No profile was written' }
Write-Host 'Kainos Talk started, opened Choose your apps, and is still running.'
Stop-Process -Id $app.Id -Force
