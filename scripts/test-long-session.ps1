param(
  [Parameter(Mandatory=$true)][string]$BuildDir,
  [int]$MatrixEntries = 2000,
  [int]$MatrixQueries = 100,
  [int]$PeerMiB = 512,
  [int]$PeerRounds = 5
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$build = (Resolve-Path -LiteralPath $BuildDir).Path
$snapshot = Join-Path $build 'conversation_snapshot_test.exe'
$peer = Join-Path $build 'peer_cache_bench.exe'
if (!(Test-Path -LiteralPath $snapshot)) { throw "conversation_snapshot_test.exe not found in $build" }
if (!(Test-Path -LiteralPath $peer)) { throw "peer_cache_bench.exe not found in $build" }

Push-Location $repo
try {
  & node --test scripts/tests/context-memory.test.mjs scripts/tests/agent-orchestrator.test.mjs
  if ($LASTEXITCODE -ne 0) { throw 'long-session Node tests failed' }
  & node scripts/bench_long_memory.mjs $MatrixEntries $MatrixQueries
  if ($LASTEXITCODE -ne 0) { throw 'context-matrix benchmark failed' }
  & ctest --test-dir $build -R 'conversation_snapshot_test$|conversation_snapshot_test_park_peer' --output-on-failure
  if ($LASTEXITCODE -ne 0) { throw 'conversation snapshot tests failed' }
  & $peer 0 1 $PeerMiB $PeerRounds
  if ($LASTEXITCODE -ne 0) { throw 'peer cache benchmark failed' }
} finally {
  Pop-Location
}
