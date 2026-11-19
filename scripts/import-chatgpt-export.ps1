param(
  [Parameter(Mandatory = $true)]
  [string]$Archive,
  [string]$Project = 'chatgpt-history',
  [string]$MemoryRoot = (Join-Path $env:LOCALAPPDATA 'StratInfer\long-session-memory'),
  [string]$FastMcpDb = $env:STRATINFER_MCP_MEMORY_DB,
  [ValidateRange(512, 7000)]
  [int]$ChunkChars = 6000,
  [switch]$SkipContextMemory,
  [switch]$SkipFastMcp,
  [switch]$NoFastMcpBackup
)

$ErrorActionPreference = 'Stop'
$archivePath = [IO.Path]::GetFullPath($Archive)
if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) { throw "Archive not found: $archivePath" }
if ([IO.Path]::GetExtension($archivePath) -ne '.zip') { throw 'Archive must be a .zip file' }
$node = Get-Command node -ErrorAction Stop
$temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) ('stratinfer-chatgpt-' + [Guid]::NewGuid().ToString('N'))
$resolvedTemporaryDirectory = [IO.Path]::GetFullPath($temporaryDirectory)
$systemTemporaryDirectory = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())

New-Item -ItemType Directory -Path $resolvedTemporaryDirectory | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = $null
try {
  $zip = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
  $selected = @($zip.Entries | Where-Object { $_.FullName -match '^(conversations-\d+|codex)\.json$' })
  if ($selected.Count -eq 0) { throw 'The archive contains no conversations-*.json or codex.json files' }
  foreach ($entry in $selected) {
    $target = Join-Path $resolvedTemporaryDirectory ([IO.Path]::GetFileName($entry.FullName))
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
  }
  $sourceId = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  $script = Join-Path $PSScriptRoot 'import_chatgpt_export.mjs'
  $arguments = @($script, '--source-dir', $resolvedTemporaryDirectory, '--source-id', $sourceId, '--project', $Project, '--memory-root', [IO.Path]::GetFullPath($MemoryRoot), '--chunk-chars', [string]$ChunkChars)
  if ($FastMcpDb) { $arguments += @('--fastmcp-db', [IO.Path]::GetFullPath($FastMcpDb)) }
  if ($SkipContextMemory) { $arguments += '--skip-context-memory' }
  if ($SkipFastMcp) { $arguments += '--skip-fastmcp' }
  if ($NoFastMcpBackup) { $arguments += '--no-fastmcp-backup' }
  & $node.Source @arguments
  if ($LASTEXITCODE -ne 0) { throw "ChatGPT import failed with exit code $LASTEXITCODE" }
} finally {
  if ($zip) { $zip.Dispose() }
  $safeTemporaryTarget = $resolvedTemporaryDirectory.StartsWith($systemTemporaryDirectory, [StringComparison]::OrdinalIgnoreCase) -and ([IO.Path]::GetFileName($resolvedTemporaryDirectory) -match '^stratinfer-chatgpt-[a-f0-9]{32}$')
  if ($safeTemporaryTarget -and (Test-Path -LiteralPath $resolvedTemporaryDirectory)) {
    Remove-Item -LiteralPath $resolvedTemporaryDirectory -Recurse -Force
  }
}
