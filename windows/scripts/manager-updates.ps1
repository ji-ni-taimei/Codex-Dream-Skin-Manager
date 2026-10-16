[CmdletBinding()]
param([ValidateSet('Check','Install')][string]$Action, [string]$ExpectedVersion = '', [string]$ApprovedHash = '')
$ErrorActionPreference = 'Stop'
$managerExpectedVersion = $ExpectedVersion
. (Join-Path $PSScriptRoot 'check-update.ps1')
$previousProtocol = [Net.ServicePointManager]::SecurityProtocol
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $currentText = ([IO.File]::ReadAllText($script:DreamSkinVersionPath)).Trim()
  $result = ConvertTo-DreamSkinUpdateResult -Release (Get-DreamSkinLatestRelease) -CurrentVersionText $currentText
  if ($Action -eq 'Install') {
    if (-not $managerExpectedVersion -or -not $ApprovedHash) { throw 'A bound update approval is required.' }
    $result = Install-DreamSkinUpdate -Result $result -Expected $managerExpectedVersion -ApprovedHash $ApprovedHash
  }
  $result | ConvertTo-Json -Compress
} finally { [Net.ServicePointManager]::SecurityProtocol = $previousProtocol }
