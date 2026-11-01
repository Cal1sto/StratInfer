param(
  [Parameter(Mandatory=$true)][string]$StrataPath,
  [switch]$AllowDirty,
  [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath $StrataPath).Path
$overlay = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$patch = Join-Path $overlay 'patches\strata-integration.patch'

if (!(Test-Path -LiteralPath (Join-Path $repo 'CMakeLists.txt'))) { throw "not a Strata checkout: $repo" }
if (!(Test-Path -LiteralPath (Join-Path $repo 'src\core\verify.cpp'))) { throw "Strata verify.cpp not found: $repo" }
if (!$AllowDirty) {
  $dirty = @(& git -C $repo status --porcelain)
  if ($LASTEXITCODE -ne 0) { throw 'unable to inspect Strata checkout status' }
  if ($dirty.Count -ne 0) { throw 'Strata checkout has changes or untracked files; commit/stash them or pass -AllowDirty' }
}
& git -C $repo apply --check --recount $patch
if ($LASTEXITCODE -ne 0) { throw 'integration patch does not apply to this Strata revision' }
if ($CheckOnly) { Write-Host "overlay applies cleanly to $repo"; exit 0 }

$copies = @{
  'include\strata\grammar\draft_chain.hpp' = 'include\strata\grammar\draft_chain.hpp'
  'include\strata\grammar\gguf_tokens.hpp' = 'include\strata\grammar\gguf_tokens.hpp'
  'include\strata\grammar\json_automaton.hpp' = 'include\strata\grammar\json_automaton.hpp'
  'include\strata\grammar\schema_loader.hpp' = 'include\strata\grammar\schema_loader.hpp'
  'include\strata\kernels\grammar_mask.hpp' = 'include\strata\kernels\grammar_mask.hpp'
  'include\strata\qwen35\philox.hpp' = 'include\strata\qwen35\philox.hpp'
  'src\core\json_automaton_test.cpp' = 'src\core\json_automaton_test.cpp'
  'src\core\gguf_tokens_test.cpp' = 'src\core\gguf_tokens_test.cpp'
  'src\core\verify.cpp.patched' = 'src\core\verify.cpp'
  'src\core\verify.hpp.patched' = 'include\strata\core\verify.hpp'
  'src\kernels\cuda\grammar_mask.cu' = 'src\kernels\cuda\grammar_mask.cu'
  'src\kernels\grammar_mask_parity.cu' = 'src\kernels\grammar_mask_parity.cu'
  'src\kernels\peer_cache_bench.cu' = 'src\kernels\peer_cache_bench.cu'
  'src\program\grammar_wiring.inc' = 'src\program\grammar_wiring.inc'
  'src\qwen35\philox_test.cpp' = 'src\qwen35\philox_test.cpp'
}

foreach ($sourceRelative in $copies.Keys) {
  $source = Join-Path $overlay $sourceRelative
  $destination = Join-Path $repo $copies[$sourceRelative]
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
  Copy-Item -LiteralPath $source -Destination $destination -Force
}
& git -C $repo apply --recount $patch
if ($LASTEXITCODE -ne 0) { throw 'integration patch failed after its clean preflight' }
Write-Host "StratInfer overlay applied to $repo"
Write-Host 'Next: configure with STRATA_ENABLE_CUDA=ON, STRATA_BUILD_TESTS=ON and CMAKE_CUDA_ARCHITECTURES=120-real.'
