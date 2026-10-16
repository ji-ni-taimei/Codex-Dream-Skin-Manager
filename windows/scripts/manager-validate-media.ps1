[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$MediaPath)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common-windows.ps1')
. (Join-Path $PSScriptRoot 'theme-windows.ps1')
try {
  Assert-DreamSkinNoReparseComponents -Path $MediaPath
  Assert-DreamSkinImageFile -Path $MediaPath
  Assert-DreamSkinVideoDecodable -Path $MediaPath
  '{"validated":true}'
} catch { exit 1 }
