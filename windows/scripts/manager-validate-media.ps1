[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$MediaPath)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common-windows.ps1')
. (Join-Path $PSScriptRoot 'theme-windows.ps1')
try {
  Assert-DreamSkinNoReparseComponents -Path $MediaPath
  Assert-DreamSkinImageFile -Path $MediaPath
  # Import checks the file contract only. Applying a theme establishes the
  # Codex connection and checks real decoding before replacing the active skin.
  '{"validated":true}'
} catch { exit 1 }
