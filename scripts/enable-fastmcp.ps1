param(
  [Parameter(Mandatory=$true)][string]$ProfileJson,
  [Parameter(Mandatory=$true)][string]$PythonExe,
  [string]$ServerScript = (Join-Path $PSScriptRoot '..\tools\stratinfer_fastmcp.py'),
  [string]$WorkspaceRoot = (Join-Path $PSScriptRoot '..'),
  [Parameter(Mandatory=$true)][string]$MemoryDb,
  [string]$BaseUrl = 'http://127.0.0.1:11441',
  [string]$DeployDirectory = ''
)
$ErrorActionPreference = 'Stop'

$profilePath = (Resolve-Path -LiteralPath $ProfileJson).Path
$pythonPath = (Resolve-Path -LiteralPath $PythonExe).Path
$sourceServerPath = (Resolve-Path -LiteralPath $ServerScript).Path
$workspacePath = (Resolve-Path -LiteralPath $WorkspaceRoot).Path
& $pythonPath -c 'from mcp.server.fastmcp import FastMCP'
if ($LASTEXITCODE -ne 0) { throw 'Python MCP SDK with FastMCP is not available' }

if ([string]::IsNullOrWhiteSpace($DeployDirectory)) {
  $DeployDirectory = Join-Path (Split-Path -Parent $profilePath) 'mcp'
}
New-Item -ItemType Directory -Force -Path $DeployDirectory | Out-Null
$serverPath = Join-Path ([IO.Path]::GetFullPath($DeployDirectory)) 'stratinfer_fastmcp.py'
Copy-Item -LiteralPath $sourceServerPath -Destination $serverPath -Force

$stamp = (Get-Date).ToString('yyyyMMddTHHmmss')
$backup = "$profilePath.fastmcp-$stamp.bak"
Copy-Item -LiteralPath $profilePath -Destination $backup
$profile = Get-Content -LiteralPath $profilePath -Raw | ConvertFrom-Json

$serverConfig = [ordered]@{
  command = $pythonPath
  args = @($serverPath)
  cwd = $workspacePath
  env = [ordered]@{
    STRATINFER_MCP_WORKSPACE = $workspacePath
    STRATINFER_MCP_MEMORY_DB = [IO.Path]::GetFullPath($MemoryDb)
    STRATINFER_MCP_MEMORY_MAX_BYTES = '34359738368'
    STRATINFER_BASE = $BaseUrl.TrimEnd('/')
    PYTHONUNBUFFERED = '1'
  }
}
$servers = [ordered]@{}
if ($profile.PSObject.Properties['mcp_servers']) {
  foreach ($property in $profile.mcp_servers.PSObject.Properties) { $servers[$property.Name] = $property.Value }
}
$servers['stratinfer'] = $serverConfig
$profile | Add-Member -Force -NotePropertyName mcp_servers -NotePropertyValue ([pscustomobject]$servers)
$profile | Add-Member -Force -NotePropertyName mcp -NotePropertyValue ([pscustomobject][ordered]@{
  timeout_s = 15
  start_timeout_s = 15
  max_result_chars = 24000
  max_rounds = 4
  image_results = $false
})

$temp = "$profilePath.fastmcp.tmp"
$profile | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $temp -Encoding UTF8
Move-Item -LiteralPath $temp -Destination $profilePath -Force
Write-Host "FastMCP configured: $profilePath"
Write-Host "Pinned server: $serverPath"
Write-Host "Backup: $backup"
Write-Host 'Restart StratInfer, then verify GET /mcp before enabling model-driven tool calls.'
