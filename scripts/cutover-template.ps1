# cutover-template.ps1 - safe parameterized engine config cutover.
# Pattern proven on a live engine (backup -> validate -> stop -> apply delta -> start ->
# health probe -> failsafe restore). Adapt the four parameters to your engine, never run
# against a shared engine without scheduling the ~30s downtime with its users first.
# Keep this file pure ASCII: PowerShell 5.1 on non-English Windows misparses smart quotes.
param(
  [Parameter(Mandatory=$true)][string]$ProfileJson,   # engine profile (args/env live here)
  [Parameter(Mandatory=$true)][string]$StopCmd,       # e.g. 'powershell -File stop-engine.ps1'
  [Parameter(Mandatory=$true)][string]$StartCmd,      # e.g. 'powershell -File start-engine.ps1'
  [string]$HealthUrl = 'http://127.0.0.1:11440/health',
  [string[]]$AddArgs = @(),                           # args to append to the profile args
  [string[]]$RemoveArgPairs = @(),                    # args to drop (flag [value])
  [hashtable]$SetEnv = @{},                           # env vars to set in the profile
  [string[]]$UnsetEnv = @()                           # env vars to remove
)
$ErrorActionPreference = 'Stop'
$stamp = (Get-Date).ToString('yyyyMMddTHHmmss')
$backup = "$PSScriptRoot\..\profile-backups\profile-$stamp.json"
New-Item -ItemType Directory -Force -Split $backup | Out-Null
Copy-Item $ProfileJson $backup
Write-Host "backup: $backup"

# 1. validate anchors before any mutation
$pj = Get-Content $ProfileJson -Raw
foreach ($pair in $RemoveArgPairs) {
  if ($pj -notlike "*$pair*") { throw "anchor not found in profile: $pair (aborting, engine untouched)" }
}
$profile = Get-Content $ProfileJson -Raw | ConvertFrom-Json

# 2. apply delta (shape-to-your-profile: adjust the property names)
if ($profile.PSObject.Properties['args']) {
  $args2 = @($profile.args)
  foreach ($r in $RemoveArgPairs) { $args2 = $args2 | Where-Object { $_ -ne $r } }
  $args2 += $AddArgs
  $profile.args = $args2
}
if ($profile.PSObject.Properties['env']) {
  foreach ($k in $UnsetEnv) { $profile.env.PSObject.Properties.Remove($k) }
  foreach ($k in $SetEnv.Keys) { $profile.env | Add-Member -Force -NotePropertyName $k -NotePropertyValue $SetEnv[$k] }
}
# idempotence: if no anchor matched and no delta was requested, do not restart for nothing
if ($AddArgs.Count -eq 0 -and $RemoveArgPairs.Count -eq 0 -and $SetEnv.Count -eq 0 -and $UnsetEnv.Count -eq 0) {
  throw 'empty delta: nothing to apply'
}
$profile | ConvertTo-Json -Depth 10 | Set-Content $ProfileJson -Encoding UTF8

# 3. restart
Invoke-Expression $StopCmd
Start-Sleep -Seconds 3
Invoke-Expression $StartCmd

# 4. health probe, with failsafe restore
$ok = $false
$deadline = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $deadline) {
  try {
    $h = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 5
    if ($h) { $ok = $true; break }
  } catch { Start-Sleep -Seconds 3 }
}
if (-not $ok) {
  Write-Host 'ENGINE DID NOT COME BACK: restoring backup' -ForegroundColor Red
  Copy-Item $backup $ProfileJson -Force
  Invoke-Expression $StopCmd; Start-Sleep -Seconds 3; Invoke-Expression $StartCmd
  throw 'cutover failed; previous profile restored'
}
Write-Host "cutover OK; backup kept at $backup"
# after the cutover: run the benches and compare against the acceptance rule written in
# configs/candidates/<id>.json. Roll back from the NAMED backup (not 'the latest') if it fails.
