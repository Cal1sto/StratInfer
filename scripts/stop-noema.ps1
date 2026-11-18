param([string]$DataRoot = 'E:\Data\NOEMA')
$ErrorActionPreference = 'Stop'
$DataRoot = [IO.Path]::GetFullPath($DataRoot)
$stateFile = Join-Path $DataRoot 'noema-state.json'
if (!(Test-Path -LiteralPath $stateFile -PathType Leaf)) {
  [pscustomobject]@{ stopped=$false; reason='not running' } | ConvertTo-Json
  return
}
$state = Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
$process = Get-Process -Id ([int]$state.pid) -ErrorAction Stop
$samePath = $process.Path -and ([IO.Path]::GetFullPath($process.Path) -eq [IO.Path]::GetFullPath([string]$state.node))
$sameStart = $process.StartTime.ToUniversalTime().ToString('o') -eq ([datetime]$state.started_at).ToUniversalTime().ToString('o')
if (!$samePath -or !$sameStart) { throw 'NOEMA process identity does not match the state file; refusing to stop it' }
Stop-Process -Id $process.Id
$null = $process.WaitForExit(10000)
if (!$process.HasExited) { throw 'NOEMA did not stop within 10 seconds' }
Remove-Item -LiteralPath $stateFile
[pscustomobject]@{ stopped=$true; pid=[int]$state.pid } | ConvertTo-Json
