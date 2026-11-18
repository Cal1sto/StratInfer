param(
  [string]$DataRoot = 'E:\Data\NOEMA',
  [string]$ConfigJson = '',
  [string]$NodeExe = '',
  [string]$MoaiRoot = "$env:LOCALAPPDATA\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local\MOAI",
  [ValidateRange(1024,65535)][int]$Port = 12160,
  [switch]$NoCodex,
  [switch]$NoMoai
)
$ErrorActionPreference = 'Stop'

$service = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\services\noema\src\index.mjs'))
if (!(Test-Path -LiteralPath $service -PathType Leaf)) { throw "NOEMA service not found: $service" }
if (!$NodeExe) { $NodeExe = (Get-Command node -ErrorAction Stop).Source }
$NodeExe = [IO.Path]::GetFullPath($NodeExe)
$DataRoot = [IO.Path]::GetFullPath($DataRoot)
New-Item -ItemType Directory -Path $DataRoot -Force | Out-Null
$stateFile = Join-Path $DataRoot 'noema-state.json'
$tokenFile = Join-Path $DataRoot 'control-token.txt'
$stdout = Join-Path $DataRoot 'noema.log'
$stderr = Join-Path $DataRoot 'noema-error.log'

if (Test-Path -LiteralPath $stateFile) {
  try {
    $state = Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $process = Get-Process -Id ([int]$state.pid) -ErrorAction Stop
    $samePath = $process.Path -and ([IO.Path]::GetFullPath($process.Path) -eq [IO.Path]::GetFullPath([string]$state.node))
    $sameStart = $process.StartTime.ToUniversalTime().ToString('o') -eq ([datetime]$state.started_at).ToUniversalTime().ToString('o')
    if ($samePath -and $sameStart) {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($state.port)/health" -TimeoutSec 3
      [pscustomobject]@{ started=$false; already_running=$true; pid=$process.Id; origin="http://127.0.0.1:$($state.port)"; health=$health } | ConvertTo-Json -Depth 8
      return
    }
  } catch {}
  throw "stale or unverifiable NOEMA state file: $stateFile"
}

if (!(Test-Path -LiteralPath $tokenFile -PathType Leaf)) {
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  [IO.File]::WriteAllText($tokenFile, ([Convert]::ToBase64String($bytes)), (New-Object Text.UTF8Encoding($false)))
  if ($env:OS -eq 'Windows_NT') {
    & icacls $tokenFile /inheritance:r /grant:r "$env:USERNAME`:(R,W)" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'failed to restrict NOEMA token file ACL' }
  }
}

$moaiToken = $env:NOEMA_MOAI_TOKEN
if (!$NoMoai -and !$moaiToken) {
  $secretScript = Join-Path $MoaiRoot 'Application\scripts\secret.ps1'
  $secretFile = Join-Path $MoaiRoot 'server.dpapi'
  if (!(Test-Path -LiteralPath $secretScript -PathType Leaf) -or !(Test-Path -LiteralPath $secretFile -PathType Leaf)) {
    throw 'MOAI administrator credentials are unavailable; use -NoMoai for an isolated NOEMA service'
  }
  $credentialsJson = & powershell.exe -NoProfile -NonInteractive -File $secretScript -Action read -Path $secretFile
  if ($LASTEXITCODE -ne 0) { throw 'failed to decrypt the local MOAI credential' }
  $moaiToken = [string](($credentialsJson | ConvertFrom-Json).admin)
  if (!$moaiToken) { throw 'the local MOAI credential has no administrator identity' }
}

$saved = @{}
foreach ($name in @('NOEMA_ROOT','NOEMA_PORT','NOEMA_TOKEN_FILE','NOEMA_CONFIG','NOEMA_CODEX_ENABLED','NOEMA_MOAI_ENABLED','NOEMA_MOAI_TOKEN')) {
  $saved[$name] = [Environment]::GetEnvironmentVariable($name,'Process')
}
try {
  $env:NOEMA_ROOT = $DataRoot
  $env:NOEMA_PORT = [string]$Port
  $env:NOEMA_TOKEN_FILE = $tokenFile
  if ($ConfigJson) { $env:NOEMA_CONFIG = [IO.Path]::GetFullPath($ConfigJson) }
  $env:NOEMA_CODEX_ENABLED = if ($NoCodex) { '0' } else { '1' }
  $env:NOEMA_MOAI_ENABLED = if ($NoMoai) { '0' } else { '1' }
  if (!$NoMoai) { $env:NOEMA_MOAI_TOKEN = $moaiToken }
  $process = Start-Process -FilePath $NodeExe -ArgumentList @($service) -WorkingDirectory ([IO.Path]::GetDirectoryName($service)) -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
} finally {
  foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name,$saved[$name],'Process') }
}

$ready = $null
for ($attempt=0; $attempt -lt 60; $attempt++) {
  if ($process.HasExited) { throw "NOEMA exited during startup; inspect $stderr" }
  try { $ready = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 1; break } catch { Start-Sleep -Milliseconds 500 }
}
if (!$ready) {
  Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  throw "NOEMA did not become ready; inspect $stderr"
}
$state = [ordered]@{
  pid = $process.Id
  started_at = $process.StartTime.ToUniversalTime().ToString('o')
  node = $NodeExe
  service = $service
  port = $Port
  data_root = $DataRoot
  token_file = $tokenFile
}
$temporary = "$stateFile.$PID.tmp"
$state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temporary -Encoding UTF8
Move-Item -LiteralPath $temporary -Destination $stateFile
[pscustomobject]@{ started=$true; already_running=$false; pid=$process.Id; origin="http://127.0.0.1:$Port"; token_file=$tokenFile; health=$ready } | ConvertTo-Json -Depth 8
