[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$Root)

$ErrorActionPreference = 'Stop'
. (Join-Path $Root 'scripts\common-windows.ps1')
. (Join-Path $Root 'scripts\theme-windows.ps1')
. (Join-Path $Root 'scripts\localization-windows.ps1')

function Assert-CommunityValueRejected {
  param(
    [Parameter(Mandatory = $true)][scriptblock]$Action,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $rejected = $false
  try { $null = & $Action } catch { $rejected = $true }
  if (-not $rejected) { throw "Community theme contract unexpectedly accepted $Label." }
}

function Invoke-CommunityOperationLockProbe {
  param(
    [Parameter(Mandatory = $true)][string]$PowerShellPath,
    [Parameter(Mandatory = $true)][string]$CommonPath,
    [Parameter(Mandatory = $true)][int]$TimeoutMilliseconds,
    [Parameter(Mandatory = $true)][bool]$ExpectSuccess
  )
  $escapedCommonPath = $CommonPath.Replace("'", "''")
  $lockCall = if ($TimeoutMilliseconds -lt 0) {
    '$lock = Enter-DreamSkinOperationLock'
  } else {
    '$lock = Enter-DreamSkinOperationLock -TimeoutMilliseconds ' + $TimeoutMilliseconds
  }
  $expectLiteral = if ($ExpectSuccess) { '$true' } else { '$false' }
  $childSource = @"
`$ErrorActionPreference = 'Stop'
. '$escapedCommonPath'
`$lock = `$null
`$exitCode = 0
try {
  $lockCall
  if (-not $expectLiteral) { `$exitCode = 81 }
} catch {
  if ($expectLiteral) { `$exitCode = 82 }
} finally {
  if (`$null -ne `$lock) { Exit-DreamSkinOperationLock -Mutex `$lock }
}
exit `$exitCode
"@
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childSource))
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $child = Start-Process -FilePath $PowerShellPath -ArgumentList @(
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded
  ) -Wait -PassThru
  $watch.Stop()
  return [pscustomobject]@{
    ExitCode = $child.ExitCode
    ElapsedMilliseconds = $watch.ElapsedMilliseconds
  }
}

$isWindowsHost = $PSVersionTable.PSEdition -eq 'Desktop' -or
  [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
if ($isWindowsHost) {
  $powerShellExecutable = if ($PSVersionTable.PSEdition -eq 'Core') {
    Join-Path $PSHOME 'pwsh.exe'
  } else {
    Join-Path $PSHOME 'powershell.exe'
  }
  if (-not (Test-Path -LiteralPath $powerShellExecutable -PathType Leaf)) {
    $powerShellExecutable = (Get-Process -Id $PID -ErrorAction Stop).Path
  }
  $commonPath = Join-Path $Root 'scripts\common-windows.ps1'
  $heldOperationLock = Enter-DreamSkinOperationLock
  try {
    $failFastProbe = Invoke-CommunityOperationLockProbe `
      -PowerShellPath $powerShellExecutable -CommonPath $commonPath `
      -TimeoutMilliseconds -1 -ExpectSuccess $false
    $boundedFailureProbe = Invoke-CommunityOperationLockProbe `
      -PowerShellPath $powerShellExecutable -CommonPath $commonPath `
      -TimeoutMilliseconds 600 -ExpectSuccess $false
  } finally {
    Exit-DreamSkinOperationLock -Mutex $heldOperationLock
  }
  $boundedSuccessProbe = Invoke-CommunityOperationLockProbe `
    -PowerShellPath $powerShellExecutable -CommonPath $commonPath `
    -TimeoutMilliseconds 3000 -ExpectSuccess $true
  if ($failFastProbe.ExitCode -ne 0 -or $failFastProbe.ElapsedMilliseconds -gt 15000 -or
    $boundedFailureProbe.ExitCode -ne 0 -or
    $boundedFailureProbe.ElapsedMilliseconds -lt 500 -or
    $boundedSuccessProbe.ExitCode -ne 0) {
    throw 'The real Windows operation mutex did not preserve fail-fast and bounded-wait behavior.'
  }
}

$applyPath = Join-Path $Root 'scripts\apply-community-theme.ps1'
$applyBytes = [System.IO.File]::ReadAllBytes($applyPath)
if ($applyBytes.Length -lt 3 -or $applyBytes[0] -ne 0xEF -or
  $applyBytes[1] -ne 0xBB -or $applyBytes[2] -ne 0xBF) {
  throw 'The localized community handler must retain a UTF-8 BOM for Windows PowerShell 5.1.'
}
$tokens = $null
$parseErrors = $null
$applyAst = [System.Management.Automation.Language.Parser]::ParseFile(
  $applyPath,
  [ref]$tokens,
  [ref]$parseErrors
)
if ($parseErrors.Count -gt 0) {
  throw "Community theme apply script failed to parse: $($parseErrors[0].Message)"
}
$applySource = [System.IO.File]::ReadAllText($applyPath)
foreach ($requiredSafety in @(
  'Copy-DreamSkinImportedThemeSnapshot',
  'Assert-DreamSkinCommunityActiveBaseline',
  'Set-DreamSkinActiveThemeFromSnapshot',
  'Get-DreamSkinThemeRuntimeContentFingerprint',
  'Invoke-DreamSkinCommunityStartAndVerify',
  '$childCompletionGraceMilliseconds = 300000',
  'WaitForExit($childCompletionTimeoutMilliseconds)',
  "' -ResultToken ' + `$resultToken",
  'Read-DreamSkinStartResult',
  "['DreamSkinStartStateUnconfirmed']",
  "Get-DreamSkinCommunityText -Key 'CommunityStartTimedOut'",
  'Remove-Item -LiteralPath $resultPath',
  "['DreamSkinRecovery']",
  "Join-Path `$PSScriptRoot 'start-dream-skin.ps1'",
  "' -RestartExisting'",
  'Restore-DreamSkinActiveThemeSnapshot'
)) {
  if (-not $applySource.Contains($requiredSafety)) {
    throw "Community theme apply script is missing a safety boundary: $requiredSafety"
  }
}
foreach ($forbiddenBehavior in @(
  'Invoke-Expression',
  'DownloadString(',
  'DownloadFile(',
  '-ExecutionPolicy Bypass',
  '[switch]$Silent',
  'Start-Process -FilePath $Uri',
  'Invoke-Item $Uri',
  'Stop-Process -InputObject $startProcess -Force'
)) {
  if ($applySource.Contains($forbiddenBehavior)) {
    throw "Community theme apply script contains forbidden behavior: $forbiddenBehavior"
  }
}

$transactionAst = $applyAst.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -ceq 'Invoke-DreamSkinCommunityThemeTransaction'
}, $true)
$exceptionHelperAst = $applyAst.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -ceq 'New-DreamSkinCommunityApplyException'
}, $true)
$baselineHelperAst = $applyAst.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -ceq 'Assert-DreamSkinCommunityActiveBaseline'
}, $true)
$activeStateHelperAst = $applyAst.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -ceq 'Get-DreamSkinCommunityActiveState'
}, $true)
$startFailureMessageHelperAst = $applyAst.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -ceq 'Get-DreamSkinCommunityStartFailureMessage'
}, $true)
$startStateExceptionHelperAst = $applyAst.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -ceq 'New-DreamSkinCommunityStartStateException'
}, $true)
$startAndVerifyHelperAst = $applyAst.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -ceq 'Invoke-DreamSkinCommunityStartAndVerify'
}, $true)
if ($null -eq $transactionAst -or
  $null -eq $exceptionHelperAst -or
  $null -eq $baselineHelperAst -or
  $null -eq $activeStateHelperAst -or
  $null -eq $startFailureMessageHelperAst -or
  $null -eq $startStateExceptionHelperAst -or $null -eq $startAndVerifyHelperAst) {
  throw 'A testable community apply transaction, baseline, state, or recovery helper is missing.'
}
$transactionSource = $transactionAst.Extent.Text
$transactionLockIndex = $transactionSource.IndexOf(
  '$operationLock = Enter-DreamSkinOperationLock', [System.StringComparison]::Ordinal
)
$transactionBaselineIndex = $transactionSource.IndexOf(
  'Assert-DreamSkinCommunityActiveBaseline', [System.StringComparison]::Ordinal
)
$transactionSnapshotIndex = $transactionSource.IndexOf(
  'Copy-DreamSkinActiveThemeSnapshot', [System.StringComparison]::Ordinal
)
$transactionWriteIndex = $transactionSource.IndexOf(
  'Set-DreamSkinActiveThemeFromSnapshot', [System.StringComparison]::Ordinal
)
$transactionUnlockIndex = $transactionSource.IndexOf(
  'Exit-DreamSkinOperationLock -Mutex $operationLock', [System.StringComparison]::Ordinal
)
$transactionStartIndex = $transactionSource.IndexOf(
  'Invoke-DreamSkinCommunityStartAndVerify', [System.StringComparison]::Ordinal
)
if ($transactionLockIndex -lt 0 -or $transactionBaselineIndex -le $transactionLockIndex -or
  $transactionSnapshotIndex -le $transactionBaselineIndex -or
  $transactionWriteIndex -le $transactionSnapshotIndex -or
  $transactionUnlockIndex -le $transactionWriteIndex -or
  $transactionStartIndex -le $transactionUnlockIndex) {
  throw 'The active snapshot/write lock boundary or child-start ordering regressed.'
}
if ($transactionSource.Contains('Set-DreamSkinPaused -Paused $false')) {
  throw 'One-click apply must not silently clear a click-time or newer pause choice.'
}

# Exercise the real parent wait/result helper with a delayed child contract. Its
# completion budget is independent from lock acquisition, and a still-running
# child must never be force-killed out of its recovery finally block.
& {
  param($FailureMessageSource, $StateExceptionSource, $StartSource)
  Invoke-Expression $FailureMessageSource
  Invoke-Expression $StateExceptionSource
  Invoke-Expression $StartSource

  $script:parentStartMode = 'complete'
  $script:parentWaitTimeout = 0
  $script:parentStopCalls = 0
  $script:parentReadCalls = 0
  $script:parentRemoveCalls = 0
  $script:parentResultPathProbes = 0
  $fakeProcess = [pscustomobject]@{ ExitCode = 1 }
  $fakeProcess | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {
    param([int]$Milliseconds)
    $script:parentWaitTimeout = $Milliseconds
    return $script:parentStartMode -ceq 'complete'
  }

  function Get-DreamSkinCommunityText { param([string]$Key); return $Key }
  function Assert-DreamSkinNoReparseComponents { param([string]$Path) }
  function Join-Path {
    param([AllowEmptyString()][string]$Path, [string]$ChildPath)
    return 'fixture-' + $ChildPath
  }
  function Get-DreamSkinStartResultPath { param([string]$StateRoot, [string]$Token); return 'fixture-result' }
  function ConvertTo-DreamSkinProcessArgument { param([string]$Value); return $Value }
  function Get-Command { param([string]$Name, [object]$ErrorAction); return [pscustomobject]@{ Source = 'powershell.exe' } }
  function Start-Process {
    param([string]$FilePath, [object]$ArgumentList, [string]$WindowStyle, [switch]$PassThru)
    return $fakeProcess
  }
  function Stop-Process {
    param([object]$InputObject, [switch]$Force, [object]$ErrorAction)
    $script:parentStopCalls += 1
  }
  function Read-DreamSkinStartResult {
    param([string]$StateRoot, [string]$Token)
    $script:parentReadCalls += 1
    return [pscustomobject]@{
      outcome = 'failure'
      category = 'cdp-endpoint-unavailable'
      appearanceRecovery = 'restored'
    }
  }
  function Test-Path {
    param([string]$LiteralPath, [object]$PathType)
    if ($LiteralPath -ceq 'fixture-result') {
      $script:parentResultPathProbes += 1
      return $script:parentResultPathProbes -gt 1
    }
    return $true
  }
  function Remove-Item {
    param([string]$LiteralPath, [switch]$Force, [object]$ErrorAction)
    $script:parentRemoveCalls += 1
  }

  $completedFailure = $null
  try { Invoke-DreamSkinCommunityStartAndVerify } catch { $completedFailure = $_ }
  if ($null -eq $completedFailure -or
    "$($completedFailure.Exception.Data['DreamSkinAppearanceRecovery'])" -cne 'restored' -or
    $script:parentWaitTimeout -ne 480000 -or $script:parentStopCalls -ne 0 -or
    $script:parentReadCalls -ne 1 -or $script:parentRemoveCalls -ne 1) {
    throw ("The delayed child did not receive its independent completion grace and exact " +
      "restored result (message=$($completedFailure.Exception.Message); recovery=" +
      "$($completedFailure.Exception.Data['DreamSkinAppearanceRecovery']); wait=" +
      "$script:parentWaitTimeout; stops=$script:parentStopCalls; reads=" +
      "$script:parentReadCalls; removes=$script:parentRemoveCalls).")
  }

  $script:parentStartMode = 'timeout'
  $script:parentWaitTimeout = 0
  $script:parentReadCalls = 0
  $script:parentRemoveCalls = 0
  $script:parentResultPathProbes = 0
  $timeoutFailure = $null
  try { Invoke-DreamSkinCommunityStartAndVerify } catch { $timeoutFailure = $_ }
  if ($null -eq $timeoutFailure -or
    -not [bool]$timeoutFailure.Exception.Data['DreamSkinStartStateUnconfirmed'] -or
    -not [bool]$timeoutFailure.Exception.Data['DreamSkinStartStillRunning'] -or
    $script:parentWaitTimeout -ne 480000 -or $script:parentStopCalls -ne 0 -or
    $script:parentReadCalls -ne 0 -or $script:parentRemoveCalls -ne 0) {
    throw 'A still-running child was killed, consumed, or reported as safely rolled back.'
  }
} $startFailureMessageHelperAst.Extent.Text `
  $startStateExceptionHelperAst.Extent.Text $startAndVerifyHelperAst.Extent.Text

Invoke-Expression $exceptionHelperAst.Extent.Text
Invoke-Expression $baselineHelperAst.Extent.Text
Invoke-Expression $activeStateHelperAst.Extent.Text
Invoke-Expression $transactionAst.Extent.Text

$script:communityExpectedFingerprint = '1' * 64
$script:communityRollbackFingerprint = '2' * 64
$script:communityOtherFingerprint = '3' * 64
$script:communityCurrentFingerprint = $script:communityRollbackFingerprint
$script:communityMode = 'success'
$script:communityStartCalls = 0
$script:communityStartTimeouts = @()
$script:communityRestoreCalls = 0
$script:communitySnapshotCalls = 0
$script:communityWriteCalls = 0
$script:communityPauseWriteCalls = 0
$script:communityBaselineVerifyCalls = 0
$script:communityBaselineVerifyArguments = @()
$script:communityPaused = $false
$script:communitySessionAvailable = $true
$script:communityLockDepth = 0
$script:communityMaxLockDepth = 0
$script:communityLockTimeouts = @()

function Enter-DreamSkinOperationLock {
  param([int]$TimeoutMilliseconds = 0)
  $script:communityLockTimeouts += $TimeoutMilliseconds
  if ($script:communityMode -ceq 'recovery-lock-timeout' -and
    $TimeoutMilliseconds -gt 0) {
    throw 'forced bounded recovery lock timeout'
  }
  $script:communityLockDepth += 1
  $script:communityMaxLockDepth = [Math]::Max(
    $script:communityMaxLockDepth,
    $script:communityLockDepth
  )
  return [pscustomobject]@{ TestLock = $true }
}

function Exit-DreamSkinOperationLock {
  param([Parameter(Mandatory = $true)][object]$Mutex)
  if (-not $Mutex.TestLock -or $script:communityLockDepth -ne 1) {
    throw 'The mocked operation lock was released out of order.'
  }
  $script:communityLockDepth -= 1
}

function Copy-DreamSkinImportedThemeSnapshot {
  param(
    [string]$SourceDirectory,
    [string]$Destination,
    [object]$Paths,
    [string]$ExpectedContentFingerprint
  )
  $fingerprint = if ($script:communityMode -ceq 'wrong-private-fingerprint') {
    '4' * 64
  } else {
    $ExpectedContentFingerprint
  }
  return [pscustomobject]@{ Directory = $Destination; ContentFingerprint = $fingerprint }
}

function Copy-DreamSkinActiveThemeSnapshot {
  param([object]$Paths, [string]$Destination)
  if ($script:communityLockDepth -ne 1) { throw 'Active snapshot occurred outside the operation lock.' }
  $script:communitySnapshotCalls += 1
  if ($script:communityMode -ceq 'baseline-snapshot-changed') {
    $script:communityCurrentFingerprint = $script:communityOtherFingerprint
  }
  return [pscustomobject]@{ Directory = $Destination }
}

function Get-DreamSkinThemeRuntimeContentFingerprint {
  param([string]$ThemeDirectory)
  if ($ThemeDirectory -like '*active-before') {
    if ($script:communityMode -in @(
        'baseline-snapshot-changed', 'rollback-snapshot-mismatch'
      )) {
      return $script:communityOtherFingerprint
    }
    return $script:communityRollbackFingerprint
  }
  if ($ThemeDirectory -like '*apply-candidate') { return $script:communityExpectedFingerprint }
  return $script:communityCurrentFingerprint
}

function Test-DreamSkinPaused {
  param([string]$StateRoot)
  return $script:communityPaused
}

function Test-DreamSkinPendingAppearanceTransaction {
  param([string]$BackupPath)
  return $script:communityMode -ceq 'baseline-pending-appearance'
}

function Set-DreamSkinPaused {
  param([bool]$Paused, [string]$StateRoot)
  $script:communityPauseWriteCalls += 1
  $script:communityPaused = $Paused
  return $Paused
}

function Get-DreamSkinLiveSessionContext {
  param([string]$StateRoot)
  if (-not $script:communitySessionAvailable) { return $null }
  $sessionActive = if ($script:communityMode -ceq 'baseline-session-mismatch') {
    'other-active'
  } else {
    'active'
  }
  return [pscustomobject]@{
    Paths = [pscustomobject]@{ Active = $sessionActive }
    NodePath = 'node.exe'
    Injector = 'injector.mjs'
    Port = 9335
    BrowserId = 'browser-1'
  }
}

function Invoke-DreamSkinNative {
  param(
    [string]$FilePath,
    [object[]]$ArgumentList,
    [switch]$DiscardStderr
  )
  $script:communityBaselineVerifyCalls += 1
  $script:communityBaselineVerifyArguments = @($ArgumentList)
  if ($script:communityMode -ceq 'baseline-selection-changed') {
    $script:communityCurrentFingerprint = $script:communityOtherFingerprint
  }
  if ($script:communityMode -ceq 'baseline-pause-during-verify') {
    $script:communityPaused = $true
  }
  $exitCode = if ($script:communityMode -in @('baseline-renderer-mismatch', 'baseline-bootstrap-no-session')) { 1 } else { 0 }
  return [pscustomobject]@{ ExitCode = $exitCode; Output = @('{}') }
}

function Set-DreamSkinActiveThemeFromSnapshot {
  param([string]$SnapshotDirectory, [string]$StateRoot, [string]$ExpectedContentFingerprint)
  if ($script:communityLockDepth -ne 1) { throw 'Active write occurred outside the operation lock.' }
  $script:communityWriteCalls += 1
  $script:communityCurrentFingerprint = $ExpectedContentFingerprint
  if ($script:communityMode -ceq 'partial-write-failure') {
    throw 'forced partial active-theme write failure'
  }
  return $ExpectedContentFingerprint
}

function Restore-DreamSkinActiveThemeSnapshot {
  param([string]$SnapshotDirectory, [string]$StateRoot, [string]$ExpectedContentFingerprint)
  if ($script:communityLockDepth -ne 1) { throw 'Rollback write occurred outside the operation lock.' }
  $script:communityRestoreCalls += 1
  if ($script:communityMode -ceq 'rollback-write-failure') {
    throw 'forced rollback file failure'
  }
  $script:communityCurrentFingerprint = $ExpectedContentFingerprint
  return $ExpectedContentFingerprint
}

function Invoke-DreamSkinCommunityStartAndVerify {
  param([int]$OperationLockTimeoutMilliseconds = 180000)
  if ($script:communityLockDepth -ne 0) {
    throw 'The child start script was called while the parent operation lock was held.'
  }
  $script:communityStartCalls += 1
  $script:communityStartTimeouts += $OperationLockTimeoutMilliseconds
  if ($script:communityMode -ceq 'baseline-off') {
    $script:communitySessionAvailable = $true
    return
  }
  if ($script:communityMode -ceq 'baseline-bootstrap-failure') {
    throw 'forced baseline start failure'
  }
  if ($script:communityMode -in @(
      'startup-failure', 'rollback-write-failure', 'recovery-lock-timeout', 'pause-superseded'
    ) -and
    $script:communityStartCalls -eq 1) {
    if ($script:communityMode -ceq 'pause-superseded') {
      $script:communityPaused = $true
    }
    throw 'forced imported renderer failure'
  }
  if ($script:communityMode -ceq 'preserved-rendered' -and
    $script:communityStartCalls -eq 1) {
    $exception = [System.InvalidOperationException]::new('forced preserved rendered result')
    $exception.Data['DreamSkinAppearanceRecovery'] = 'preserved-rendered'
    $exception.Data['DreamSkinStartStateUnconfirmed'] = $true
    throw $exception
  }
  if ($script:communityMode -ceq 'rollback-renderer-failure') {
    throw 'forced renderer failure'
  }
  if ($script:communityMode -ceq 'superseded' -and $script:communityStartCalls -eq 1) {
    $script:communityCurrentFingerprint = $script:communityOtherFingerprint
    throw 'forced concurrent user theme selection'
  }
}

$mockPaths = [pscustomobject]@{ Root = 'state'; Saved = 'saved'; Active = 'active' }
$mockImported = [pscustomobject]@{
  Path = 'saved\theme'
  ContentFingerprint = $script:communityExpectedFingerprint
}

function Reset-CommunityTransactionFixture {
  param([Parameter(Mandatory = $true)][string]$Mode)
  $script:communityMode = $Mode
  $script:communityCurrentFingerprint = $script:communityRollbackFingerprint
  $script:communityStartCalls = 0
  $script:communityStartTimeouts = @()
  $script:communityRestoreCalls = 0
  $script:communitySnapshotCalls = 0
  $script:communityWriteCalls = 0
  $script:communityPauseWriteCalls = 0
  $script:communityBaselineVerifyCalls = 0
  $script:communityBaselineVerifyArguments = @()
  $script:communityPaused = $Mode -ceq 'baseline-paused'
  $script:communitySessionAvailable = $Mode -notin @(
    'baseline-off', 'baseline-bootstrap-failure', 'baseline-bootstrap-no-session'
  )
  $script:communityLockDepth = 0
  $script:communityMaxLockDepth = 0
  $script:communityLockTimeouts = @()
}

function Assert-CommunityIntSequence {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Actual,
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Expected,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if (($Actual -join ',') -cne ($Expected -join ',')) {
    throw "$Label sequence was '$($Actual -join ',')', expected '$($Expected -join ',')'."
  }
}

foreach ($baselineCase in @(
  @{ Mode = 'baseline-paused'; VerifyCalls = 0 },
  @{ Mode = 'baseline-session-mismatch'; VerifyCalls = 0 },
  @{ Mode = 'baseline-renderer-mismatch'; VerifyCalls = 1 },
  @{ Mode = 'baseline-selection-changed'; VerifyCalls = 1 },
  @{ Mode = 'baseline-pause-during-verify'; VerifyCalls = 1 },
  @{ Mode = 'baseline-pending-appearance'; VerifyCalls = 0 }
)) {
  Reset-CommunityTransactionFixture -Mode $baselineCase.Mode
  Assert-CommunityValueRejected -Label $baselineCase.Mode -Action {
    Invoke-DreamSkinCommunityThemeTransaction -Imported $mockImported `
      -Paths $mockPaths -WorkRoot 'work' -StateRoot 'state'
  }
  if ($script:communityBaselineVerifyCalls -ne $baselineCase.VerifyCalls -or
    $script:communitySnapshotCalls -ne 0 -or $script:communityWriteCalls -ne 0 -or
    $script:communityPauseWriteCalls -ne 0 -or $script:communityStartCalls -ne 0 -or
    $script:communityRestoreCalls -ne 0 -or $script:communityLockDepth -ne 0) {
    throw "Click-time baseline $($baselineCase.Mode) changed active state or started the client."
  }
  Assert-CommunityIntSequence -Actual $script:communityLockTimeouts -Expected @(0) `
    -Label "Click-time baseline $($baselineCase.Mode) lock"
}

Reset-CommunityTransactionFixture -Mode 'baseline-snapshot-changed'
Assert-CommunityValueRejected -Label 'an active theme changed while its rollback snapshot was copied' -Action {
  Invoke-DreamSkinCommunityThemeTransaction -Imported $mockImported `
    -Paths $mockPaths -WorkRoot 'work' -StateRoot 'state'
}
if ($script:communityBaselineVerifyCalls -ne 1 -or
  $script:communitySnapshotCalls -ne 1 -or $script:communityWriteCalls -ne 0 -or
  $script:communityPauseWriteCalls -ne 0 -or $script:communityStartCalls -ne 0 -or
  $script:communityRestoreCalls -ne 0 -or $script:communityLockDepth -ne 0) {
  throw 'A post-verification active-theme change reached an active write or client start.'
}
Assert-CommunityIntSequence -Actual $script:communityLockTimeouts -Expected @(0) `
  -Label 'Post-verification active-theme change lock'

Reset-CommunityTransactionFixture -Mode 'success'
$success = Invoke-DreamSkinCommunityThemeTransaction -Imported $mockImported `
  -Paths $mockPaths -WorkRoot 'work' -StateRoot 'state'
if ($success.ContentFingerprint -cne $script:communityExpectedFingerprint -or
  $script:communityCurrentFingerprint -cne $script:communityExpectedFingerprint -or
  $script:communityStartCalls -ne 1 -or $script:communityRestoreCalls -ne 0 -or
  $script:communityBaselineVerifyCalls -ne 1 -or
  $script:communitySnapshotCalls -ne 1 -or $script:communityWriteCalls -ne 1 -or
  $script:communityPauseWriteCalls -ne 0 -or
  $script:communityLockDepth -ne 0 -or $script:communityMaxLockDepth -ne 1) {
  throw 'The mocked community apply success transaction did not serialize and verify exactly once.'
}
foreach ($requiredBaselineArgument in @('--verify', '--theme-dir', 'active', '--timeout-ms', '30000')) {
  if ($script:communityBaselineVerifyArguments -cnotcontains $requiredBaselineArgument) {
    throw "The click-time renderer verification omitted argument: $requiredBaselineArgument"
  }
}
Assert-CommunityIntSequence -Actual $script:communityStartTimeouts -Expected @(180000) `
  -Label 'Successful child start timeout'
Assert-CommunityIntSequence -Actual $script:communityLockTimeouts -Expected @(0, 180000) `
  -Label 'Successful operation lock'

Reset-CommunityTransactionFixture -Mode 'wrong-private-fingerprint'
Assert-CommunityValueRejected -Label 'a wrong private imported-content fingerprint' -Action {
  Invoke-DreamSkinCommunityThemeTransaction -Imported $mockImported `
    -Paths $mockPaths -WorkRoot 'work' -StateRoot 'state'
}
if ($script:communityStartCalls -ne 0 -or
  $script:communityCurrentFingerprint -cne $script:communityRollbackFingerprint -or
  $script:communitySnapshotCalls -ne 0 -or $script:communityWriteCalls -ne 0) {
  throw 'A wrong imported-content fingerprint reached the active theme or renderer.'
}
Assert-CommunityIntSequence -Actual $script:communityLockTimeouts -Expected @() `
  -Label 'Wrong private fingerprint lock'

Reset-CommunityTransactionFixture -Mode 'partial-write-failure'
$partialWriteError = $null
try {
  $null = Invoke-DreamSkinCommunityThemeTransaction -Imported $mockImported `
    -Paths $mockPaths -WorkRoot 'work' -StateRoot 'state'
} catch {
  $partialWriteError = $_
}
if ($null -eq $partialWriteError -or
  "$($partialWriteError.Exception.Data['DreamSkinRecovery'])" -cne 'Verified' -or
  $script:communityCurrentFingerprint -cne $script:communityRollbackFingerprint -or
  $script:communityRestoreCalls -ne 1 -or $script:communityStartCalls -ne 1) {
  throw 'A partial active-theme write did not restore and visibly verify the exact prior theme.'
}
Assert-CommunityIntSequence -Actual $script:communityStartTimeouts -Expected @(180000) `
  -Label 'Partial-write recovery start timeout'
Assert-CommunityIntSequence -Actual $script:communityLockTimeouts -Expected @(0, 180000) `
  -Label 'Partial-write recovery lock'

Reset-CommunityTransactionFixture -Mode 'startup-failure'
$startupError = $null
try {
  $null = Invoke-DreamSkinCommunityThemeTransaction -Imported $mockImported `
    -Paths $mockPaths -WorkRoot 'work' -StateRoot 'state'
} catch {
  $startupError = $_
}
if ($null -eq $startupError -or
  "$($startupError.Exception.Data['DreamSkinRecovery'])" -cne 'Verified' -or
  $script:communityCurrentFingerprint -cne $script:communityRollbackFingerprint -or
  $script:communityRestoreCalls -ne 1 -or $script:communityStartCalls -ne 2) {
  throw 'A failed imported renderer did not restart and visibly verify the exact rollback theme.'
}
Assert-CommunityIntSequence -Actual $script:communityStartTimeouts `
  -Expected @(180000, 180000) -Label 'Renderer rollback start timeout'
Assert-CommunityIntSequence -Actual $script:communityLockTimeouts `
  -Expected @(0, 180000, 180000) -Label 'Renderer rollback lock'

Reset-CommunityTransactionFixture -Mode 'preserved-rendered'
$preservedRenderedError = $null
try {
  $null = Invoke-DreamSkinCommunityThemeTransaction -Imported $mockImported `
    -Paths $mockPaths -WorkRoot 'work' -StateRoot 'state'
} catch {
  $preservedRenderedError = $_
}
if ($null -eq $preservedRenderedError -or
  "$($preservedRenderedError.Exception.Data['DreamSkinRecovery'])" -cne 'Failed' -or
  $script:communityCurrentFingerprint -cne $script:communityExpectedFingerprint -or
  $script:communityRestoreCalls -ne 0 -or $script:communityStartCalls -ne 1) {
  throw 'A preserved rendered child result rewrote active-theme files into mixed state.'
}

Reset-CommunityTransactionFixture -Mode 'rollback-write-failure'
$rollbackWriteError = $null
try {
  $null = Invoke-DreamSkinCommunityThemeTransaction -Imported $mockImported `
    -Paths $mockPaths -WorkRoot 'work' -StateRoot 'state'
} catch {
  $rollbackWriteError = $_
}
if ($null -eq $rollbackWriteError -or
  "$($rollbackWriteError.Exception.Data['DreamSkinRecovery'])" -cne 'Failed' -or
  "$($rollbackWriteError.Exception.Data['DreamSkinRollbackSnapshot'])" -notlike '*active-before' -or
  "$($rollbackWriteError.Exception.Data['DreamSkinRollbackFingerprint'])" -cne
    $script:communityRollbackFingerprint -or
  $script:communityRestoreCalls -ne 1 -or $script:communityStartCalls -ne 1) {
  throw 'A rollback file failure was not reported as an unverified recovery.'
}
Assert-CommunityIntSequence -Actual $script:communityStartTimeouts -Expected @(180000) `
  -Label 'Rollback-write failure start timeout'
Assert-CommunityIntSequence -Actual $script:communityLockTimeouts -Expected @(0, 180000) `
  -Label 'Rollback-write failure lock'

Reset-CommunityTransactionFixture -Mode 'rollback-renderer-failure'
$rollbackRendererError = $null
try {
  $null = Invoke-DreamSkinCommunityThemeTransaction -Imported $mockImported `
    -Paths $mockPaths -WorkRoot 'work' -StateRoot 'state'
} catch {
  $rollbackRendererError = $_
}
if ($null -eq $rollbackRendererError -or
  "$($rollbackRendererError.Exception.Data['DreamSkinRecovery'])" -cne 'Failed' -or
  $script:communityCurrentFingerprint -cne $script:communityRollbackFingerprint -or
  $script:communityRestoreCalls -ne 1 -or $script:communityStartCalls -ne 2) {
  throw 'A rollback renderer failure was incorrectly reported as verified recovery.'
}
Assert-CommunityIntSequence -Actual $script:communityStartTimeouts `
  -Expected @(180000, 180000) -Label 'Rollback-renderer start timeout'
Assert-CommunityIntSequence -Actual $script:communityLockTimeouts `
  -Expected @(0, 180000, 180000) -Label 'Rollback-renderer lock'

Reset-CommunityTransactionFixture -Mode 'superseded'
$supersededError = $null
try {
  $null = Invoke-DreamSkinCommunityThemeTransaction -Imported $mockImported `
    -Paths $mockPaths -WorkRoot 'work' -StateRoot 'state'
} catch {
  $supersededError = $_
}
if ($null -eq $supersededError -or
  "$($supersededError.Exception.Data['DreamSkinRecovery'])" -cne 'Superseded' -or
  $script:communityCurrentFingerprint -cne $script:communityOtherFingerprint -or
  $script:communityRestoreCalls -ne 0) {
  throw 'A concurrent user theme selection was overwritten by stale rollback.'
}
Assert-CommunityIntSequence -Actual $script:communityStartTimeouts -Expected @(180000) `
  -Label 'Superseded selection start timeout'
Assert-CommunityIntSequence -Actual $script:communityLockTimeouts -Expected @(0, 180000) `
  -Label 'Superseded selection lock'

Reset-CommunityTransactionFixture -Mode 'pause-superseded'
$pauseSupersededError = $null
try {
  $null = Invoke-DreamSkinCommunityThemeTransaction -Imported $mockImported `
    -Paths $mockPaths -WorkRoot 'work' -StateRoot 'state'
} catch {
  $pauseSupersededError = $_
}
if ($null -eq $pauseSupersededError -or
  "$($pauseSupersededError.Exception.Data['DreamSkinRecovery'])" -cne 'Superseded' -or
  -not $script:communityPaused -or $script:communityPauseWriteCalls -ne 0 -or
  $script:communityRestoreCalls -ne 0) {
  throw 'A newer pause choice was cleared or overwritten by stale one-click recovery.'
}
Assert-CommunityIntSequence -Actual $script:communityStartTimeouts -Expected @(180000) `
  -Label 'Pause supersession start timeout'
Assert-CommunityIntSequence -Actual $script:communityLockTimeouts -Expected @(0, 180000) `
  -Label 'Pause supersession lock'

Reset-CommunityTransactionFixture -Mode 'recovery-lock-timeout'
$recoveryLockError = $null
try {
  $null = Invoke-DreamSkinCommunityThemeTransaction -Imported $mockImported `
    -Paths $mockPaths -WorkRoot 'work' -StateRoot 'state'
} catch {
  $recoveryLockError = $_
}
if ($null -eq $recoveryLockError -or
  "$($recoveryLockError.Exception.Data['DreamSkinRecovery'])" -cne 'Failed' -or
  "$($recoveryLockError.Exception.Data['DreamSkinRollbackSnapshot'])" -notlike '*active-before' -or
  "$($recoveryLockError.Exception.Data['DreamSkinRollbackFingerprint'])" -cne
    $script:communityRollbackFingerprint -or
  $script:communityRestoreCalls -ne 0 -or $script:communityStartCalls -ne 1) {
  throw 'A bounded recovery lock timeout did not retain exact rollback evidence.'
}
Assert-CommunityIntSequence -Actual $script:communityStartTimeouts -Expected @(180000) `
  -Label 'Recovery lock-timeout start timeout'
Assert-CommunityIntSequence -Actual $script:communityLockTimeouts -Expected @(0, 180000) `
  -Label 'Recovery lock-timeout lock'

Write-Host 'PASS: Windows community publication, serialized apply, child-start results, and verified rollback are fail-closed.'
