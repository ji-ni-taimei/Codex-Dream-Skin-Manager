[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$RequestPath)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common-windows.ps1')
$trashState = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'CodexDreamSkin'))
$trashRequests = Join-Path $trashState 'manager-operations\trash-requests'
$trashRequest = [IO.Path]::GetFullPath($RequestPath)
if ([IO.Path]::GetDirectoryName($trashRequest) -cne $trashRequests -or [IO.Path]::GetFileName($trashRequest) -notmatch '^[a-f0-9-]{36}\.json$') { throw 'Invalid recycling request.' }
Assert-DreamSkinNoReparseComponents -Path $trashRequest
if ((Get-Item -LiteralPath $trashRequest).Length -gt 16384) { throw 'Invalid recycling descriptor.' }
$trashDescriptor = [IO.File]::ReadAllText($trashRequest) | ConvertFrom-Json
if ($trashDescriptor.schemaVersion -ne 1 -or $trashDescriptor.location -notin @('state','presets') -or $trashDescriptor.name -notmatch '^\.manager-library-delete-[a-f0-9-]{36}$') { throw 'Invalid recycling descriptor.' }
$trashApplication = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
if ([IO.Path]::GetFullPath($trashDescriptor.applicationRoot) -cne $trashApplication) { throw 'Invalid recycling application root.' }
$trashRoot = if ($trashDescriptor.location -eq 'state') { $trashState } else { Join-Path $trashApplication 'windows\presets' }
$trashTarget = [IO.Path]::GetFullPath((Join-Path $trashRoot $trashDescriptor.name))
if ([IO.Path]::GetDirectoryName($trashTarget) -cne $trashRoot) { throw 'Invalid recycling target.' }
Assert-DreamSkinNoReparseComponents -Path $trashTarget
if (-not (Test-Path -LiteralPath $trashTarget -PathType Container)) { throw 'The isolated preset is unavailable.' }
$trashPending = New-Object 'System.Collections.Generic.Stack[object]'
$trashPending.Push([pscustomobject]@{ Path = $trashTarget; Depth = 0 })
$trashCount = 0
while ($trashPending.Count -gt 0) {
  $trashDirectory = $trashPending.Pop()
  Assert-DreamSkinNoReparseComponents -Path $trashDirectory.Path
  foreach ($trashMember in Get-ChildItem -LiteralPath $trashDirectory.Path -Force) {
    $trashCount++
    if ($trashCount -gt 4096 -or $trashDirectory.Depth -ge 8) { throw 'Recycling tree exceeds its bounded traversal limit.' }
    Assert-DreamSkinNoReparseComponents -Path $trashMember.FullName
    if ($trashMember.PSIsContainer) { $trashPending.Push([pscustomobject]@{ Path = $trashMember.FullName; Depth = $trashDirectory.Depth + 1 }) }
  }
}
Add-Type -AssemblyName Microsoft.VisualBasic
[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($trashTarget,
  [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
  [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)
[ordered]@{ recycled = $true } | ConvertTo-Json -Compress
