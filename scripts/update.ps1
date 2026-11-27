# Install a downloaded release over this computer's app, and put the window back.
# Started by the server (POST /api/update/install); it outlives the window it closes,
# the same way scripts/rebuild.ps1 does, because the thing it replaces is the app that
# would otherwise be waiting for it.
#
# The download already happened — the server streams it, so progress can be reported —
# and this only has to close, install and reopen.
# -NoRelaunch is install-on-quit: the person closed the app, so it stays closed.
# -Ready names the server's note about the downloaded file, which goes with the installer.
param([string]$Installer = "", [string]$Exe = "", [string]$Log = "", [switch]$NoRelaunch, [string]$Ready = "")
$ErrorActionPreference = "Continue"
if (-not $Log) { $Log = Join-Path $env:TEMP "claude-anywhere-update.log" }
function Say($m) { $line = "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $m; Add-Content -Path $Log -Value $line -Encoding utf8 }

if (-not (Test-Path $Installer)) { Say "the installer is not where the server left it: $Installer"; Say "done"; exit 1 }

# Whatever is running from the install folder, not a hard-coded name: the crate can be
# renamed, and the binary is named after it.
$dir = if ($Exe) { Split-Path $Exe -Parent } else { "" }
$running = @()
if ($dir) { $running = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -like "$dir*" } }
if ($running) {
  Say "closing the window ($($running.Count) process$(if ($running.Count -ne 1) { 'es' }))"
  foreach ($p in $running) { try { $p.Kill(); [void]$p.WaitForExit(15000) } catch {} }
} else {
  Say "no window open; installing straight away"
}

# The webview processes the app spawned hold files in the install folder for a few
# seconds after it goes, and the installer will not overwrite what is still open.
Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'claude-anywhere|Claude Anywhere' } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
Start-Sleep -Seconds 3

$target = $Exe
if (-not $target -and $dir) { $target = (Get-ChildItem $dir -Filter '*.exe' -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -notlike '*setup*' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName }
# What is there before, so "it has been replaced" is something we can see rather than
# assume: the file already exists, so its presence proves nothing.
$was = if ($target) { Get-Item $target -ErrorAction SilentlyContinue } else { $null }
$wasStamp = if ($was) { $was.LastWriteTimeUtc } else { [DateTime]::MinValue }
$wasVersion = if ($was) { $was.VersionInfo.FileVersion } else { "" }

Say "installing $(Split-Path $Installer -Leaf)"
# NSIS: /S is silent. The Tauri installer is per-user, so no elevation prompt appears.
$p = Start-Process -FilePath $Installer -ArgumentList "/S" -PassThru -Wait
$code = $p.ExitCode
if ($null -eq $code) { $code = 0 }
if ($code -ne 0) { Say "the installer exited with $code" } else { Say "the installer finished" }

# ...which is not the same as the install being over. NSIS hands off to a second stage
# and returns, so starting the app here caught a binary that was still being written —
# it opened and died, and the window never came back. Wait for the file itself to change.
$deadline = (Get-Date).AddSeconds(120)
$replaced = $false
while ((Get-Date) -lt $deadline) {
  $now = if ($target) { Get-Item $target -ErrorAction SilentlyContinue } else { $null }
  if ($now -and $now.LastWriteTimeUtc -gt $wasStamp) { $replaced = $true; break }
  Start-Sleep -Milliseconds 500
}
# And for the installer's own processes to let go of the folder.
$waited = 0
while ((Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -like '*setup*.exe' }) -and $waited -lt 60) { Start-Sleep -Milliseconds 500; $waited++ }
Start-Sleep -Seconds 2

if ($NoRelaunch) {
  Say "installed; leaving the app closed, as it was quit"
} elseif ($target -and (Test-Path $target)) {
  $nowVersion = (Get-Item $target).VersionInfo.FileVersion
  if ($replaced) { Say "installed $nowVersion (was $wasVersion)" } else { Say "the binary did not change; starting what is there ($nowVersion)" }
  Say "starting the app"
  Start-Process -FilePath $target -WorkingDirectory (Split-Path $target)
  Start-Sleep -Seconds 8
  $up = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $target }
  # One retry: the first start can still land on an installer that has not quite let go,
  # and a window that does not come back is the whole complaint.
  if (-not $up) {
    Say "it did not come up; trying once more"
    Start-Sleep -Seconds 4
    Start-Process -FilePath $target -WorkingDirectory (Split-Path $target)
    Start-Sleep -Seconds 8
    $up = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $target }
  }
  Say ("app is back: " + [bool]$up)
  if (-not $up) { Say "open Claude Anywhere yourself this once, and tell the log above" }
} else {
  Say "the app is not where it was; open it from the Start menu"
}
try { Remove-Item $Installer -Force -ErrorAction SilentlyContinue } catch {}
if ($Ready) { try { Remove-Item $Ready -Force -ErrorAction SilentlyContinue } catch {} }
Say "done"
