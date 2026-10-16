[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ApplicationRoot,
  [Parameter(Mandatory = $true)][string]$RequestPath
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common-windows.ps1')
. (Join-Path $PSScriptRoot 'theme-windows.ps1')
$state = Join-Path $env:LOCALAPPDATA 'CodexDreamSkin'
$operationLock = $null
$previous = $env:CODEX_MANAGER_LIBRARY_LOCK_HELD
$workerStarted = $false
try {
  $operationLock = Enter-DreamSkinOperationLock -TimeoutMilliseconds 5000
  $env:CODEX_MANAGER_LIBRARY_LOCK_HELD = '1'
  $node = Join-Path $ApplicationRoot 'runtime\node\node.exe'
  $worker = Join-Path $ApplicationRoot 'shared\core\library-worker.mjs'
  Assert-DreamSkinNoReparseComponents -Path $node
  Assert-DreamSkinNoReparseComponents -Path $worker
  $workerStarted = $true
  & $node $worker $ApplicationRoot $RequestPath
  if ($LASTEXITCODE -ne 0) { throw 'The library worker did not complete.' }
} catch {
  [ordered]@{ libraryChanged = if ($workerStarted) { $null } else { $false }; resultTheme = $null; resultRevision = $null;
    disposition = $null;
    error = [ordered]@{ code = 'RUNTIME_UNAVAILABLE'; message = 'The locked library transaction could not complete.'; retryable = $false } } | ConvertTo-Json -Depth 4 -Compress
} finally {
  if ($null -eq $previous) { Remove-Item Env:CODEX_MANAGER_LIBRARY_LOCK_HELD -ErrorAction SilentlyContinue }
  else { $env:CODEX_MANAGER_LIBRARY_LOCK_HELD = $previous }
  if ($null -ne $operationLock) { Exit-DreamSkinOperationLock -Mutex $operationLock }
}
