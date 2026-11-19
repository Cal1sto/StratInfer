param(
  [Parameter(Mandatory=$true)][string]$ProfileJson,
  [string]$DataRoot = 'E:\Data\NOEMA',
  [string]$PythonExe = 'C:\ProgramData\Anaconda3\python.exe',
  [string]$NoemaBase = 'http://127.0.0.1:12160',
  [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
if (!(Test-Path -LiteralPath $ProfileJson -PathType Leaf)) { throw "profile not found: $ProfileJson" }
if (!(Test-Path -LiteralPath $PythonExe -PathType Leaf)) { throw "Python not found: $PythonExe" }
$tool = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\tools\noema_control_fastmcp.py'))
if (!(Test-Path -LiteralPath $tool -PathType Leaf)) { throw "NOEMA MCP tool not found: $tool" }
$tokenFile = Join-Path ([IO.Path]::GetFullPath($DataRoot)) 'control-token.txt'
if (!(Test-Path -LiteralPath $tokenFile -PathType Leaf)) { throw "NOEMA token file not found: $tokenFile" }
$profile = Get-Content -LiteralPath $ProfileJson -Raw -Encoding UTF8 | ConvertFrom-Json
if (!$profile.mcp_servers) { $profile | Add-Member -NotePropertyName mcp_servers -NotePropertyValue ([pscustomobject]@{}) }
$entry = [pscustomobject]@{
  command = [IO.Path]::GetFullPath($PythonExe)
  args = @($tool)
  cwd = [IO.Path]::GetDirectoryName($tool)
  env = [pscustomobject]@{
    NOEMA_BASE = $NoemaBase
    NOEMA_TOKEN_FILE = $tokenFile
    PYTHONUNBUFFERED = '1'
  }
}
if ($profile.mcp_servers.PSObject.Properties['noema_control']) { $profile.mcp_servers.noema_control = $entry }
else { $profile.mcp_servers | Add-Member -NotePropertyName noema_control -NotePropertyValue $entry }
$result = [ordered]@{ profile=[IO.Path]::GetFullPath($ProfileJson); tool=$tool; token_file=$tokenFile; changed=$false; backup=$null }
if ($CheckOnly) { [pscustomobject]$result | ConvertTo-Json -Depth 8; return }
$stamp = Get-Date -Format 'yyyyMMddTHHmmss'
$backup = "$ProfileJson.noema-mcp-$stamp.bak"
$temporary = "$ProfileJson.$PID.$stamp.tmp"
Copy-Item -LiteralPath $ProfileJson -Destination $backup
$profile | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath $temporary -Encoding UTF8
$validated = Get-Content -LiteralPath $temporary -Raw -Encoding UTF8 | ConvertFrom-Json
if (!$validated.mcp_servers.noema_control -or $validated.mcp_servers.noema_control.env.NOEMA_TOKEN_FILE -ne $tokenFile) { throw 'generated NOEMA MCP profile failed validation' }
Move-Item -LiteralPath $temporary -Destination $ProfileJson -Force
$result.changed = $true
$result.backup = $backup
[pscustomobject]$result | ConvertTo-Json -Depth 8
