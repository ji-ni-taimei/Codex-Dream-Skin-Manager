[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$ApplicationRoot, [Parameter(Mandatory = $true)][string]$RequestPath)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'apply-community-theme.ps1')
. (Join-Path $PSScriptRoot 'manager-platform.ps1') -Action Probe -ApplicationRoot $ApplicationRoot -RequestPath $RequestPath -FunctionsOnly
Set-StrictMode -Off

function Invoke-ManagerCommunityGuard {
  $probe = Get-ManagerPlatformProbe
  $encoded = 'base64:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($probe | ConvertTo-Json -Depth 10 -Compress)))
  $guardText = & $Node (Join-Path $ApplicationRoot 'shared\core\community-worker.mjs') $ApplicationRoot $RequestPath $encoded
  if ($LASTEXITCODE -ne 0) { throw 'Community preconditions changed.' }
  return ($guardText -join "`n") | ConvertFrom-Json
}
$effects = [ordered]@{ themeCommitted = $false; rendererApplied = $false; codexRestarted = $false; rollbackVerified = $false }
$transaction = $null
$lock = $null
$script:publicationAuthorized = $false
$previousHeld = $env:CODEX_DREAM_SKIN_RECOVERY_LOCK_HELD
try {
  # The publication transaction releases its mutex before invoking start. Do not
  # hold this preparation mutex across that child process.
  $lock = Enter-DreamSkinOperationLock -TimeoutMilliseconds 5000
  try {
    $env:CODEX_DREAM_SKIN_RECOVERY_LOCK_HELD = '1'
    $guard = Invoke-ManagerCommunityGuard
    $transaction = "$($guard.recoveryTransaction)"
    $workRoot = Join-Path $StateRoot $transaction
    if (Test-Path -LiteralPath $workRoot) { throw 'Community transaction already exists; query its operation instead.' }
    Ensure-DreamSkinManagedDirectory -Path $workRoot -Root $StateRoot
    $snapshot = Invoke-ManagerPlatformWorker -Mode prepare
    $paths = Get-DreamSkinThemePaths -StateRoot $StateRoot
    $imported = [pscustomobject]@{ Path = "$($snapshot.directory)"; ContentFingerprint = Get-DreamSkinThemeRuntimeContentFingerprint -ThemeDirectory "$($snapshot.directory)" }
  } finally {
    Exit-DreamSkinOperationLock -Mutex $lock; $lock = $null
    if ($null -eq $previousHeld) { Remove-Item Env:CODEX_DREAM_SKIN_RECOVERY_LOCK_HELD -ErrorAction SilentlyContinue }
    else { $env:CODEX_DREAM_SKIN_RECOVERY_LOCK_HELD = $previousHeld }
  }
  $beforeCommit = {
    $callbackHeld = $env:CODEX_DREAM_SKIN_RECOVERY_LOCK_HELD
    try {
      $env:CODEX_DREAM_SKIN_RECOVERY_LOCK_HELD = '1'
      $null = Invoke-ManagerCommunityGuard
      $script:publicationAuthorized = $true
    } finally {
      if ($null -eq $callbackHeld) { Remove-Item Env:CODEX_DREAM_SKIN_RECOVERY_LOCK_HELD -ErrorAction SilentlyContinue }
      else { $env:CODEX_DREAM_SKIN_RECOVERY_LOCK_HELD = $callbackHeld }
    }
  }
  $null = Invoke-DreamSkinCommunityThemeTransaction -Imported $imported -Paths $paths -WorkRoot $workRoot -StateRoot $StateRoot -ManagerBeforeCommit $beforeCommit 6>$null 3>$null
  $effects.themeCommitted = $true; $effects.rendererApplied = $null; $effects.codexRestarted = $true
  $inspectionResult = Invoke-DreamSkinPowerShellScript -ScriptPath (Join-Path $PSScriptRoot 'manager-platform.ps1') `
    -ArgumentList @('-Action', 'CommitCommunity', '-ApplicationRoot', $ApplicationRoot, '-RequestPath', $RequestPath)
  if ($inspectionResult.ExitCode -ne 0) { throw 'The exact manager renderer receipt is unavailable.' }
  $mapped = ($inspectionResult.Output -join "`n") | ConvertFrom-Json
  if ($mapped.effects.themeCommitted -ne $true -or $mapped.effects.rendererApplied -ne $true) { throw 'The exact manager renderer receipt is unverified.' }
  $mapped.effects | Add-Member -NotePropertyName codexRestarted -NotePropertyValue $true -Force
  $mapped | Add-Member -NotePropertyName recoveryTransaction -NotePropertyValue $transaction
  $mapped | ConvertTo-Json -Depth 8 -Compress
} catch {
  $recovery = "$($_.Exception.Data['DreamSkinRecovery'])"
  if ($recovery -eq 'Verified') {
    $effects.themeCommitted = $false; $effects.rendererApplied = $false; $effects.codexRestarted = $true; $effects.rollbackVerified = $true
  } elseif ($script:publicationAuthorized) {
    $effects.themeCommitted = $null; $effects.rendererApplied = $null; $effects.codexRestarted = $null; $effects.rollbackVerified = $null
  }
  $result = [ordered]@{ effects = $effects; committedRevision = $null; verifiedRendererRevision = $null; runtimeSessionId = $null }
  if ($transaction) { $result.recoveryTransaction = $transaction }
  $result | ConvertTo-Json -Depth 8 -Compress
} finally { if ($null -ne $lock) { Exit-DreamSkinOperationLock -Mutex $lock } }
