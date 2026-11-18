param(
  [Parameter(Mandatory=$true)][ValidateSet('voice-balanced','agent-max')][string]$Profile,
  [Parameter(Mandatory=$true)][string]$StratInferProfileJson,
  [string]$MoaiRegistryJson = "$env:LOCALAPPDATA\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local\MOAI\registry.json",
  [string]$MoaiBaseUrl = 'http://127.0.0.1:12150',
  [string]$ProfilesJson = '',
  [switch]$CheckOnly,
  [switch]$SkipVoiceCheck
)
$ErrorActionPreference = 'Stop'
if (!$ProfilesJson) { $ProfilesJson = Join-Path $PSScriptRoot '..\configs\noema-resource-profiles.json' }

foreach ($file in @($StratInferProfileJson,$MoaiRegistryJson,$ProfilesJson)) {
  if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw "file not found: $file" }
}
$profiles = Get-Content -LiteralPath $ProfilesJson -Raw -Encoding UTF8 | ConvertFrom-Json
$selected = $profiles.profiles.$Profile
if (!$selected) { throw "resource profile not found: $Profile" }
$engine = Get-Content -LiteralPath $StratInferProfileJson -Raw -Encoding UTF8 | ConvertFrom-Json
$registry = Get-Content -LiteralPath $MoaiRegistryJson -Raw -Encoding UTF8 | ConvertFrom-Json
if (!$engine.env -or !$engine.args) { throw 'StratInfer profile must contain env and args' }

$device = [int]$profiles.helper_device
$gpuRows = @(& nvidia-smi --query-gpu=index,memory.total,memory.free --format=csv,noheader,nounits)
$gpu = $gpuRows | ForEach-Object {
  $parts = $_ -split ',' | ForEach-Object { $_.Trim() }
  [pscustomobject]@{ index=[int]$parts[0]; total_mib=[int]$parts[1]; free_mib=[int]$parts[2] }
} | Where-Object index -eq $device | Select-Object -First 1
if (!$gpu) { throw "CUDA device $device was not reported by nvidia-smi" }

$safe = [math]::Max(0, $gpu.free_mib - [int]$selected.helper_reserve_mib)
$rounded = [math]::Floor($safe / 512) * 512
$helperMiB = [math]::Min([int]$selected.helper_target_mib, [int]$rounded)
if ($helperMiB -lt [int]$selected.helper_min_mib) {
  throw "$Profile requires at least $($selected.helper_min_mib) MiB helper cache after a $($selected.helper_reserve_mib) MiB reserve; only $helperMiB MiB is safe"
}

$voice = $null
try { $voice = Invoke-RestMethod -Uri "$MoaiBaseUrl/health" -TimeoutSec 5 } catch {
  if ($selected.voice_required_stopped -and !$SkipVoiceCheck) { throw "MOAI health is required before agent-max: $($_.Exception.Message)" }
}
if ($selected.voice_required_stopped -and !$SkipVoiceCheck -and ($voice.asr.ready -or $voice.speech.ready)) {
  throw 'agent-max requires ASR and TTS to be released first through NOEMA or the MOAI owner API'
}

$cacheIndex = [Array]::IndexOf([object[]]@($engine.args), '--conversation-cache-mib')
if ($cacheIndex -lt 0 -or $cacheIndex + 1 -ge $engine.args.Count) { throw 'StratInfer profile has no --conversation-cache-mib value' }
if (!$engine.env.PSObject.Properties['STRATA_PARK_VRAM_DEVICE']) { $engine.env | Add-Member -NotePropertyName STRATA_PARK_VRAM_DEVICE -NotePropertyValue ([string]$device) }
if (!$engine.env.PSObject.Properties['STRATA_PARK_VRAM_MIB']) { $engine.env | Add-Member -NotePropertyName STRATA_PARK_VRAM_MIB -NotePropertyValue ([string]$helperMiB) }

$engineBefore = [ordered]@{
  helper_mib = [int]$engine.env.STRATA_PARK_VRAM_MIB
  host_cache_mib = [int]$engine.args[$cacheIndex + 1]
}
$engine.env.STRATA_PARK_VRAM_DEVICE = [string]$device
$engine.env.STRATA_PARK_VRAM_MIB = [string]$helperMiB
$engine.env.STRATA_PARK_ASYNC = '1'
$engine.args[$cacheIndex + 1] = [string][int]$selected.host_cache_mib

$textEngine = $registry.textEngines | Where-Object id -eq 'stratinfer' | Select-Object -First 1
if (!$textEngine) { throw 'MOAI registry has no stratinfer text engine' }
$textEngine.helperVramBytes = [int64]$helperMiB * 1024 * 1024
$textEngine.description = "sm120 sur RTX 5090, profil NOEMA $Profile, cache K/V auxiliaire plafonne a $helperMiB MiB."

$result = [ordered]@{
  profile = $Profile
  helper_device = $device
  helper_total_mib = $gpu.total_mib
  helper_free_mib_observed = $gpu.free_mib
  helper_reserve_mib = [int]$selected.helper_reserve_mib
  helper_cache_mib = $helperMiB
  estimated_hot_snapshots = [math]::Floor($helperMiB / [int]$profiles.snapshot_mib)
  host_cache_mib = [int]$selected.host_cache_mib
  voice_ready = [bool]($voice -and ($voice.asr.ready -or $voice.speech.ready))
  before = $engineBefore
  changed = $false
  backups = @()
}
if ($CheckOnly) { [pscustomobject]$result | ConvertTo-Json -Depth 8; return }

$stamp = Get-Date -Format 'yyyyMMddTHHmmss'
$engineBackup = "$StratInferProfileJson.noema-$stamp.bak"
$registryBackup = "$MoaiRegistryJson.noema-$stamp.bak"
$engineTemp = "$StratInferProfileJson.$PID.$stamp.tmp"
$registryTemp = "$MoaiRegistryJson.$PID.$stamp.tmp"
$engine | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath $engineTemp -Encoding UTF8
$registry | ConvertTo-Json -Depth 60 | Set-Content -LiteralPath $registryTemp -Encoding UTF8
$validatedEngine = Get-Content -LiteralPath $engineTemp -Raw -Encoding UTF8 | ConvertFrom-Json
$validatedRegistry = Get-Content -LiteralPath $registryTemp -Raw -Encoding UTF8 | ConvertFrom-Json
if ([int]$validatedEngine.env.STRATA_PARK_VRAM_MIB -ne $helperMiB) { throw 'generated engine profile failed validation' }
if ([int64](($validatedRegistry.textEngines | Where-Object id -eq 'stratinfer').helperVramBytes) -ne [int64]$helperMiB * 1024 * 1024) { throw 'generated MOAI registry failed validation' }
Copy-Item -LiteralPath $StratInferProfileJson -Destination $engineBackup
Copy-Item -LiteralPath $MoaiRegistryJson -Destination $registryBackup
try {
  Move-Item -LiteralPath $engineTemp -Destination $StratInferProfileJson -Force
  Move-Item -LiteralPath $registryTemp -Destination $MoaiRegistryJson -Force
} catch {
  Copy-Item -LiteralPath $engineBackup -Destination $StratInferProfileJson -Force
  Copy-Item -LiteralPath $registryBackup -Destination $MoaiRegistryJson -Force
  throw
}
$result.changed = $true
$result.backups = @($engineBackup,$registryBackup)
[pscustomobject]$result | ConvertTo-Json -Depth 8
