[CmdletBinding()]
param(
  [string]$NodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source,
  [string]$OutputRoot = (Join-Path $PSScriptRoot 'build\CodexDreamSkinManager')
)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'hosts\windows\assemble-shared.ps1') -OutputDirectory $OutputRoot -NodeExecutable $NodeExecutable
