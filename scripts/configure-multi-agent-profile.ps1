param(
  [Parameter(Mandatory=$true)][string]$ProfileJson,
  [ValidateRange(1024,8192)][int]$HelperVramMiB = 6144,
  [ValidateRange(4096,32768)][int]$HostCacheMiB = 12288,
  [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'

if (!(Test-Path -LiteralPath $ProfileJson -PathType Leaf)) { throw "profile not found: $ProfileJson" }
$profile = Get-Content -LiteralPath $ProfileJson -Raw -Encoding UTF8 | ConvertFrom-Json
if (!$profile.PSObject.Properties['args'] -or !$profile.PSObject.Properties['env']) {
  throw 'profile must contain args and env objects'
}
$arguments = @($profile.args)
$cacheIndex = [Array]::IndexOf([object[]]$arguments, '--conversation-cache-mib')
if ($cacheIndex -lt 0 -or $cacheIndex + 1 -ge $arguments.Count) {
  throw 'profile has no --conversation-cache-mib value'
}
if (!$profile.env.PSObject.Properties['STRATA_PARK_VRAM_DEVICE']) {
  throw 'profile has no STRATA_PARK_VRAM_DEVICE helper assignment'
}

$result = [ordered]@{
  profile = (Resolve-Path -LiteralPath $ProfileJson).Path
  helper_vram_mib_before = [int]$profile.env.STRATA_PARK_VRAM_MIB
  helper_vram_mib_after = $HelperVramMiB
  host_cache_mib_before = [int]$arguments[$cacheIndex + 1]
  host_cache_mib_after = $HostCacheMiB
  helper_device = [int]$profile.env.STRATA_PARK_VRAM_DEVICE
  changed = $false
  backup = $null
}
if ($CheckOnly) {
  [pscustomobject]$result | ConvertTo-Json
  return
}

$stamp = Get-Date -Format 'yyyyMMddTHHmmss'
$backup = "$ProfileJson.multi-agent-$stamp.bak"
Copy-Item -LiteralPath $ProfileJson -Destination $backup
$profile.args[$cacheIndex + 1] = [string]$HostCacheMiB
$profile.env.STRATA_PARK_VRAM_MIB = [string]$HelperVramMiB
$temporary = "$ProfileJson.$PID.$stamp.tmp"
$profile | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $temporary -Encoding UTF8
$validated = Get-Content -LiteralPath $temporary -Raw -Encoding UTF8 | ConvertFrom-Json
if ($validated.args[$cacheIndex + 1] -ne [string]$HostCacheMiB -or
    $validated.env.STRATA_PARK_VRAM_MIB -ne [string]$HelperVramMiB) {
  throw 'generated profile failed validation; original profile was not replaced'
}
Move-Item -LiteralPath $temporary -Destination $ProfileJson -Force
$result.changed = $true
$result.backup = $backup
[pscustomobject]$result | ConvertTo-Json
