# cutover-template.ps1 - safe parameterized engine config cutover.
# Commands are arrays: @('powershell.exe','-File','stop-engine.ps1'). Avoids Invoke-Expression.
param(
  [Parameter(Mandatory=$true)][string]$ProfileJson,
  [Parameter(Mandatory=$true)][string[]]$StopCommand,
  [Parameter(Mandatory=$true)][string[]]$StartCommand,
  [string]$HealthUrl = 'http://127.0.0.1:11440/health',
  [string[]]$AddArgs = @(),
  [string[]]$RemoveArgs = @(),
  [hashtable]$SetEnv = @{},
  [string[]]$UnsetEnv = @(),
  [int]$HealthTimeoutSeconds = 120
)
$ErrorActionPreference = 'Stop'

function Invoke-EngineCommand([string[]]$Command, [string]$Name) {
  if ($Command.Count -lt 1 -or [string]::IsNullOrWhiteSpace($Command[0])) { throw "$Name command is empty" }
  $exe = $Command[0]
  $commandArgs = if ($Command.Count -gt 1) { @($Command[1..($Command.Count - 1)]) } else { @() }
  & $exe @commandArgs
  if ($LASTEXITCODE -ne 0) { throw "$Name command failed with exit code $LASTEXITCODE" }
}

function Wait-EngineHealth([string]$Url, [int]$TimeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $health = Invoke-RestMethod -Uri $Url -TimeoutSec 5
      if ($null -ne $health) { return $true }
    } catch { Start-Sleep -Seconds 3 }
  }
  return $false
}

if (!(Test-Path -LiteralPath $ProfileJson -PathType Leaf)) { throw "profile not found: $ProfileJson" }
if ($HealthTimeoutSeconds -lt 1) { throw 'HealthTimeoutSeconds must be positive' }
if ($AddArgs.Count -eq 0 -and $RemoveArgs.Count -eq 0 -and $SetEnv.Count -eq 0 -and $UnsetEnv.Count -eq 0) {
  throw 'empty delta: nothing to apply'
}

$stamp = (Get-Date).ToString('yyyyMMddTHHmmss')
$backupDir = Join-Path $PSScriptRoot '..\profile-backups'
$backup = Join-Path $backupDir "profile-$stamp.json"
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
Copy-Item -LiteralPath $ProfileJson -Destination $backup
Write-Host "backup: $backup"

$profile = Get-Content -LiteralPath $ProfileJson -Raw | ConvertFrom-Json
if (!$profile.PSObject.Properties['args']) { throw 'profile has no args property' }
if (!$profile.PSObject.Properties['env']) { $profile | Add-Member -NotePropertyName env -NotePropertyValue ([pscustomobject]@{}) }
$currentArgs = @($profile.args)
foreach ($arg in $RemoveArgs) {
  if ($currentArgs -notcontains $arg) { throw "argument not found in profile: $arg (engine untouched)" }
}
foreach ($name in $UnsetEnv) {
  if (!$profile.env.PSObject.Properties[$name]) { throw "environment key not found in profile: $name (engine untouched)" }
}

$profile.args = @($currentArgs | Where-Object { $RemoveArgs -notcontains $_ }) + @($AddArgs)
foreach ($name in $UnsetEnv) { $profile.env.PSObject.Properties.Remove($name) }
foreach ($name in $SetEnv.Keys) {
  $profile.env | Add-Member -Force -NotePropertyName $name -NotePropertyValue $SetEnv[$name]
}
$profile | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $ProfileJson -Encoding UTF8

try {
  Invoke-EngineCommand $StopCommand 'stop'
  Start-Sleep -Seconds 3
  Invoke-EngineCommand $StartCommand 'start'
  if (!(Wait-EngineHealth $HealthUrl $HealthTimeoutSeconds)) { throw 'health probe timed out' }
} catch {
  $cause = $_.Exception.Message
  Write-Host 'ENGINE DID NOT COME BACK: restoring backup' -ForegroundColor Red
  Copy-Item -LiteralPath $backup -Destination $ProfileJson -Force
  try { Invoke-EngineCommand $StopCommand 'rollback stop' } catch { Write-Warning $_ }
  Start-Sleep -Seconds 3
  Invoke-EngineCommand $StartCommand 'rollback start'
  if (!(Wait-EngineHealth $HealthUrl $HealthTimeoutSeconds)) {
    throw "cutover failed and rollback health check failed; backup: $backup; cause: $cause"
  }
  throw "cutover failed; previous profile restored and healthy; backup: $backup; cause: $cause"
}

Write-Host "cutover OK; backup kept at $backup"
