# Internal publication/start/rollback primitives for manager-community.ps1.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot 'common-windows.ps1')
. (Join-Path $PSScriptRoot 'theme-windows.ps1')
. (Join-Path $PSScriptRoot 'localization-windows.ps1')
$dreamSkinLanguage = Resolve-DreamSkinLanguage `
  -StateRoot (Join-Path $env:LOCALAPPDATA 'CodexDreamSkin')

function Get-DreamSkinCommunityText {
  param([Parameter(Mandatory = $true)][string]$Key, [object[]]$FormatArguments = @())
  Get-DreamSkinText -Key $Key -Language $dreamSkinLanguage -FormatArguments $FormatArguments
}

function Copy-DreamSkinActiveThemeSnapshot {
  param(
    [Parameter(Mandatory = $true)][object]$Paths,
    [Parameter(Mandatory = $true)][string]$Destination
  )
  if (Test-Path -LiteralPath $Destination) {
    throw 'The active-theme snapshot destination already exists.'
  }
  Ensure-DreamSkinManagedDirectory -Path $Destination -Root $Paths.Root
  $active = Read-DreamSkinTheme -ThemeDirectory $Paths.Active
  $imageName = [System.IO.Path]::GetFileName($active.ImagePath)
  Copy-Item -LiteralPath $active.ThemePath -Destination (Join-Path $Destination 'theme.json') -Force
  Copy-Item -LiteralPath $active.ImagePath -Destination (Join-Path $Destination $imageName) -Force
  $activeCss = Join-Path $Paths.Active 'theme.css'
  if (Test-Path -LiteralPath $activeCss -PathType Leaf) {
    Assert-DreamSkinSafeCssFile -Path $activeCss
    Copy-Item -LiteralPath $activeCss -Destination (Join-Path $Destination 'theme.css') -Force
  }
  return Read-DreamSkinTheme -ThemeDirectory $Destination
}

function Copy-DreamSkinImportedThemeSnapshot {
  param(
    [Parameter(Mandatory = $true)][string]$SourceDirectory,
    [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][object]$Paths,
    [Parameter(Mandatory = $true)][string]$ExpectedContentFingerprint
  )
  if ($ExpectedContentFingerprint -cnotmatch '\A[a-f0-9]{64}\z') {
    throw 'The imported theme content fingerprint is invalid.'
  }
  $sourceRoot = [System.IO.Path]::GetFullPath($SourceDirectory)
  $snapshotRoot = [IO.Path]::GetFullPath((Join-Path $Paths.Root 'manager-operations\snapshots'))
  if ([IO.Path]::GetDirectoryName($sourceRoot) -ine $snapshotRoot -or [IO.Path]::GetFileName($sourceRoot) -cnotmatch '^[a-f0-9-]{36}$') { throw 'Invalid private manager candidate.' }
  Assert-DreamSkinNoReparseComponents -Path $sourceRoot
  if (Test-Path -LiteralPath $Destination) {
    throw 'The imported-theme snapshot destination already exists.'
  }
  $source = Read-DreamSkinTheme -ThemeDirectory $sourceRoot
  $sourceCss = Join-Path $sourceRoot 'theme.css'
  Assert-DreamSkinSafeCssFile -Path $sourceCss
  Ensure-DreamSkinManagedDirectory -Path $Destination -Root $Paths.Root
  $imageName = [System.IO.Path]::GetFileName($source.ImagePath)
  Copy-Item -LiteralPath $source.ThemePath -Destination (Join-Path $Destination 'theme.json') -Force
  Copy-Item -LiteralPath $source.ImagePath -Destination (Join-Path $Destination $imageName) -Force
  Copy-Item -LiteralPath $sourceCss -Destination (Join-Path $Destination 'theme.css') -Force
  $sourceLicense = Join-Path $sourceRoot 'LICENSE.txt'
  if (Test-Path -LiteralPath $sourceLicense -PathType Leaf) {
    Assert-DreamSkinNoReparseComponents -Path $sourceLicense
    Copy-Item -LiteralPath $sourceLicense -Destination (Join-Path $Destination 'LICENSE.txt') -Force
  }
  $null = Read-DreamSkinTheme -ThemeDirectory $Destination
  Assert-DreamSkinSafeCssFile -Path (Join-Path $Destination 'theme.css')
  $contentFingerprint = Get-DreamSkinThemeRuntimeContentFingerprint -ThemeDirectory $Destination
  if ($contentFingerprint -cne $ExpectedContentFingerprint) {
    throw 'The imported theme changed before its private apply snapshot was completed.'
  }
  return [pscustomobject]@{
    Directory = $Destination
    ContentFingerprint = $contentFingerprint
  }
}

function Restore-DreamSkinActiveThemeSnapshot {
  param(
    [Parameter(Mandatory = $true)][string]$SnapshotDirectory,
    [Parameter(Mandatory = $true)][string]$StateRoot,
    [Parameter(Mandatory = $true)][string]$ExpectedContentFingerprint
  )
  $snapshot = Read-DreamSkinTheme -ThemeDirectory $SnapshotDirectory
  $theme = $snapshot.Theme | ConvertTo-Json -Depth 8 | ConvertFrom-Json
  $cssPath = Join-Path $SnapshotDirectory 'theme.css'
  if (-not (Test-Path -LiteralPath $cssPath -PathType Leaf)) { $cssPath = $null }
  $null = Set-DreamSkinActiveTheme -ImagePath $snapshot.ImagePath -Theme $theme `
    -SafeCssPath $cssPath -StateRoot $StateRoot
  $paths = Get-DreamSkinThemePaths -StateRoot $StateRoot
  $restoredFingerprint = Get-DreamSkinThemeRuntimeContentFingerprint -ThemeDirectory $paths.Active
  if ($restoredFingerprint -cne $ExpectedContentFingerprint) {
    throw 'The previous active-theme files were not restored exactly.'
  }
  return $restoredFingerprint
}

function Set-DreamSkinActiveThemeFromSnapshot {
  param(
    [Parameter(Mandatory = $true)][string]$SnapshotDirectory,
    [Parameter(Mandatory = $true)][string]$StateRoot,
    [Parameter(Mandatory = $true)][string]$ExpectedContentFingerprint
  )
  $candidateFingerprint = Get-DreamSkinThemeRuntimeContentFingerprint `
    -ThemeDirectory $SnapshotDirectory
  if ($candidateFingerprint -cne $ExpectedContentFingerprint) {
    throw 'The private imported-theme snapshot no longer matches its validated content.'
  }
  $candidate = Read-DreamSkinTheme -ThemeDirectory $SnapshotDirectory
  $cssPath = Join-Path $SnapshotDirectory 'theme.css'
  Assert-DreamSkinSafeCssFile -Path $cssPath
  $theme = $candidate.Theme | ConvertTo-Json -Depth 8 | ConvertFrom-Json
  $null = Set-DreamSkinActiveTheme -ImagePath $candidate.ImagePath -Theme $theme `
    -SafeCssPath $cssPath -StateRoot $StateRoot
  $paths = Get-DreamSkinThemePaths -StateRoot $StateRoot
  $activeFingerprint = Get-DreamSkinThemeRuntimeContentFingerprint -ThemeDirectory $paths.Active
  if ($activeFingerprint -cne $ExpectedContentFingerprint) {
    throw 'The active theme does not match the validated imported content.'
  }
  return $activeFingerprint
}

function Get-DreamSkinCommunityStartFailureMessage {
  param(
    [Parameter(Mandatory = $true)][string]$Category,
    [Parameter(Mandatory = $true)][string]$AppearanceRecovery
  )
  $messageKey = switch ($Category) {
    'cdp-launch-failed' { 'CommunityStartCdpLaunchFailed' }
    'cdp-direct-access-denied' { 'CommunityStartCdpDirectAccessDenied' }
    'cdp-endpoint-unavailable' { 'CommunityStartCdpEndpointUnavailable' }
    'port-unavailable' { 'CommunityStartPortUnavailable' }
    'state-reconciliation-failed' { 'CommunityStartStateReconciliationFailed' }
    'injector-start-failed' { 'CommunityStartInjectorFailed' }
    'renderer-verification-failed' { 'CommunityStartRendererVerificationFailed' }
    'superseded' { 'CommunityStartSuperseded' }
    default { 'CommunityStartInternalFailure' }
  }
  $message = Get-DreamSkinCommunityText -Key $messageKey
  $recoveryKey = switch ($AppearanceRecovery) {
    'restored' { 'CommunityStartAppearanceRestored' }
    'conflict-preserved' { 'CommunityStartAppearanceConflictPreserved' }
    'blocked' { 'CommunityStartAppearanceBlocked' }
    'preserved-rendered' { 'CommunityStartAppearancePreservedRendered' }
    default { $null }
  }
  if ($recoveryKey) {
    $message += ' ' + (Get-DreamSkinCommunityText -Key $recoveryKey)
  }
  return $message
}

function New-DreamSkinCommunityStartStateException {
  param(
    [Parameter(Mandatory = $true)][string]$Message,
    [switch]$StillRunning,
    [AllowNull()][System.Exception]$InnerException
  )
  $exception = if ($null -ne $InnerException) {
    [System.InvalidOperationException]::new($Message, $InnerException)
  } else {
    [System.InvalidOperationException]::new($Message)
  }
  $exception.Data['DreamSkinStartStateUnconfirmed'] = $true
  if ($StillRunning) { $exception.Data['DreamSkinStartStillRunning'] = $true }
  return $exception
}

function Invoke-DreamSkinCommunityStartAndVerify {
  param(
    [ValidateRange(1000, 300000)]
    [int]$OperationLockTimeoutMilliseconds = 180000
  )
  $startScript = Join-Path $PSScriptRoot 'start-dream-skin.ps1'
  Assert-DreamSkinNoReparseComponents -Path $startScript
  if (-not (Test-Path -LiteralPath $startScript -PathType Leaf)) {
    throw 'The managed Dream Skin start script is missing.'
  }
  $stateRoot = Join-Path $env:LOCALAPPDATA 'CodexDreamSkin'
  $resultToken = [guid]::NewGuid().ToString('N')
  $resultPath = Get-DreamSkinStartResultPath -StateRoot $stateRoot -Token $resultToken
  if (Test-Path -LiteralPath $resultPath) {
    throw (New-DreamSkinCommunityStartStateException `
      -Message (Get-DreamSkinCommunityText -Key 'CommunityStartInvalidResult') `
      -InnerException $null)
  }
  $powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
  $argumentLine = '-NoProfile -STA -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File ' +
    (ConvertTo-DreamSkinProcessArgument -Value $startScript) + ' -RestartExisting' +
    ' -RequireUnpaused -OperationLockTimeoutMilliseconds ' +
    "$OperationLockTimeoutMilliseconds" + ' -ResultToken ' + $resultToken
  $startProcess = $null
  $childExited = $false
  try {
    $startProcess = Start-Process -FilePath $powershell -ArgumentList $argumentLine `
      -WindowStyle Hidden -PassThru
    $childCompletionGraceMilliseconds = 300000
    $childCompletionTimeoutMilliseconds = [int](
      $OperationLockTimeoutMilliseconds + $childCompletionGraceMilliseconds
    )
    if (-not $startProcess.WaitForExit($childCompletionTimeoutMilliseconds)) {
      # The child may still own the operation mutex and be inside its bounded
      # rollback. Killing it here would bypass every catch/finally block. Leave
      # it running and preserve both theme states for a later verified action.
      throw (New-DreamSkinCommunityStartStateException `
        -Message (Get-DreamSkinCommunityText -Key 'CommunityStartTimedOut') `
        -StillRunning -InnerException $null)
    }
    $childExited = $true
    try {
      $result = Read-DreamSkinStartResult -StateRoot $stateRoot -Token $resultToken
    } catch {
      throw (New-DreamSkinCommunityStartStateException `
        -Message (Get-DreamSkinCommunityText -Key 'CommunityStartInvalidResult') `
        -InnerException $_.Exception)
    }
    $coherentSuccess = $startProcess.ExitCode -eq 0 -and "$($result.outcome)" -ceq 'success'
    $coherentFailure = $startProcess.ExitCode -ne 0 -and "$($result.outcome)" -ceq 'failure'
    if (-not ($coherentSuccess -or $coherentFailure)) {
      throw (New-DreamSkinCommunityStartStateException `
        -Message (Get-DreamSkinCommunityText -Key 'CommunityStartInvalidResult') `
        -InnerException $null)
    }
    if ($coherentFailure) {
      $message = Get-DreamSkinCommunityStartFailureMessage `
        -Category "$($result.category)" -AppearanceRecovery "$($result.appearanceRecovery)"
      $exception = [System.InvalidOperationException]::new($message)
      $exception.Data['DreamSkinStartCategory'] = "$($result.category)"
      $exception.Data['DreamSkinAppearanceRecovery'] = "$($result.appearanceRecovery)"
      if ("$($result.appearanceRecovery)" -in @('retained', 'blocked', 'preserved-rendered')) {
        $exception.Data['DreamSkinStartStateUnconfirmed'] = $true
      }
      throw $exception
    }
  } finally {
    if ($childExited -and (Test-Path -LiteralPath $resultPath)) {
      Remove-Item -LiteralPath $resultPath -Force -ErrorAction SilentlyContinue
    }
  }
}

function Assert-DreamSkinCommunityActiveBaseline {
  param(
    [Parameter(Mandatory = $true)][object]$Paths,
    [Parameter(Mandatory = $true)][string]$StateRoot,
    [ValidateRange(1000, 120000)]
    [int]$RendererTimeoutMilliseconds = 30000
  )
  $backupPath = Join-Path $StateRoot 'config.before-dream-skin.toml'
  if (Test-DreamSkinPendingAppearanceTransaction -BackupPath $backupPath) {
    throw 'One-click apply is blocked until the interrupted appearance transaction is recovered.'
  }
  if (Test-DreamSkinPaused -StateRoot $StateRoot) {
    throw 'One-click apply requires an active, unpaused Dream Skin renderer.'
  }
  $selectedFingerprint = Get-DreamSkinThemeRuntimeContentFingerprint `
    -ThemeDirectory $Paths.Active
  $session = Get-DreamSkinLiveSessionContext -StateRoot $StateRoot
  if ($null -eq $session) {
    $exception = [System.InvalidOperationException]::new(
      'One-click apply requires an existing verified Dream Skin session.'
    )
    $exception.Data['DreamSkinBaselineCategory'] = 'session-unavailable'
    throw $exception
  }
  if (-not (Test-DreamSkinPathEqual -Left $session.Paths.Active -Right $Paths.Active)) {
    throw 'The active Dream Skin session does not use the selected theme directory.'
  }
  $verify = Invoke-DreamSkinNative -FilePath $session.NodePath -ArgumentList @(
    $session.Injector,
    '--verify',
    '--port', "$($session.Port)",
    '--browser-id', $session.BrowserId,
    '--theme-dir', $Paths.Active,
    '--timeout-ms', "$RendererTimeoutMilliseconds"
  ) -DiscardStderr
  if ($verify.ExitCode -ne 0) {
    throw 'The selected theme is not the exact theme currently visible in Codex.'
  }
  if (Test-DreamSkinPaused -StateRoot $StateRoot) {
    throw 'A pause request superseded one-click apply during baseline verification.'
  }
  $verifiedFingerprint = Get-DreamSkinThemeRuntimeContentFingerprint `
    -ThemeDirectory $Paths.Active
  if ($verifiedFingerprint -cne $selectedFingerprint) {
    throw 'The selected theme changed during baseline renderer verification.'
  }
  return [pscustomobject]@{ ContentFingerprint = $verifiedFingerprint }
}

function Get-DreamSkinCommunityActiveState {
  param(
    [Parameter(Mandatory = $true)][object]$Paths,
    [Parameter(Mandatory = $true)][string]$StateRoot,
    [ValidateRange(1000, 300000)]
    [int]$OperationLockTimeoutMilliseconds = 180000
  )
  $stateLock = Enter-DreamSkinOperationLock `
    -TimeoutMilliseconds $OperationLockTimeoutMilliseconds
  try {
    $paused = Test-DreamSkinPaused -StateRoot $StateRoot
    $fingerprint = $null
    $readable = $false
    try {
      $fingerprint = Get-DreamSkinThemeRuntimeContentFingerprint `
        -ThemeDirectory $Paths.Active
      $readable = $true
    } catch {}
    return [pscustomobject]@{
      Paused = $paused
      Readable = $readable
      Fingerprint = $fingerprint
    }
  } finally {
    Exit-DreamSkinOperationLock -Mutex $stateLock
  }
}

function New-DreamSkinCommunityApplyException {
  param(
    [Parameter(Mandatory = $true)][string]$Message,
    [ValidateSet('Verified', 'Failed', 'Superseded')][string]$Recovery,
    [AllowNull()][System.Exception]$InnerException,
    [AllowNull()][string]$RollbackSnapshot,
    [AllowNull()][string]$RollbackFingerprint
  )
  $exception = if ($null -ne $InnerException) {
    [System.InvalidOperationException]::new($Message, $InnerException)
  } else {
    [System.InvalidOperationException]::new($Message)
  }
  $exception.Data['DreamSkinRecovery'] = $Recovery
  if ($Recovery -ceq 'Failed' -and $RollbackSnapshot -and $RollbackFingerprint) {
    $exception.Data['DreamSkinRollbackSnapshot'] = $RollbackSnapshot
    $exception.Data['DreamSkinRollbackFingerprint'] = $RollbackFingerprint
  }
  return $exception
}

function Invoke-DreamSkinCommunityThemeTransaction {
  param(
    [Parameter(Mandatory = $true)][object]$Imported,
    [Parameter(Mandatory = $true)][object]$Paths,
    [Parameter(Mandatory = $true)][string]$WorkRoot,
    [Parameter(Mandatory = $true)][string]$StateRoot,
    [ValidateRange(1000, 300000)]
    [int]$OperationLockTimeoutMilliseconds = 180000,
    [scriptblock]$ManagerBeforeCommit
  )
  if ($Imported.ContentFingerprint -isnot [string] -or
    $Imported.ContentFingerprint -cnotmatch '\A[a-f0-9]{64}\z') {
    throw 'The prepared manager snapshot did not provide a valid content fingerprint.'
  }
  $expectedFingerprint = $Imported.ContentFingerprint
  $candidateRoot = Join-Path $WorkRoot 'apply-candidate'
  $candidate = Copy-DreamSkinImportedThemeSnapshot -SourceDirectory $Imported.Path `
    -Destination $candidateRoot -Paths $Paths -ExpectedContentFingerprint $expectedFingerprint
  if ($candidate.ContentFingerprint -cne $expectedFingerprint) {
    throw 'The private imported-theme snapshot identity is inconsistent.'
  }

  $snapshotRoot = Join-Path $WorkRoot 'active-before'
  $rollbackFingerprint = $null
  $writeFailure = $null
  $rollbackWriteFailure = $null
  $operationLock = Enter-DreamSkinOperationLock
  try {
    $baseline = Assert-DreamSkinCommunityActiveBaseline -Paths $Paths `
      -StateRoot $StateRoot
    $null = Copy-DreamSkinActiveThemeSnapshot -Paths $Paths -Destination $snapshotRoot
    $rollbackFingerprint = Get-DreamSkinThemeRuntimeContentFingerprint `
      -ThemeDirectory $snapshotRoot
    if ($rollbackFingerprint -cne $baseline.ContentFingerprint) {
      throw 'The active theme changed between renderer verification and rollback snapshot.'
    }
    if ((Get-DreamSkinThemeRuntimeContentFingerprint -ThemeDirectory $candidateRoot) -cne
      $expectedFingerprint) {
      throw 'The private imported-theme snapshot changed before application.'
    }
    if ($null -ne $ManagerBeforeCommit) { & $ManagerBeforeCommit }
    try {
      $null = Set-DreamSkinActiveThemeFromSnapshot -SnapshotDirectory $candidateRoot `
        -StateRoot $StateRoot -ExpectedContentFingerprint $expectedFingerprint
    } catch {
      $writeFailure = $_
      try {
        $null = Restore-DreamSkinActiveThemeSnapshot -SnapshotDirectory $snapshotRoot `
          -StateRoot $StateRoot -ExpectedContentFingerprint $rollbackFingerprint
      } catch {
        $rollbackWriteFailure = $_
      }
    }
  } finally {
    Exit-DreamSkinOperationLock -Mutex $operationLock
  }

  if ($null -ne $writeFailure) {
    if ($null -ne $rollbackWriteFailure) {
      throw (New-DreamSkinCommunityApplyException `
        -Message ("The imported theme could not be written, and the previous active-theme files " +
          "could not be restored: $($rollbackWriteFailure.Exception.Message)") `
        -Recovery 'Failed' -InnerException $writeFailure.Exception `
        -RollbackSnapshot $snapshotRoot -RollbackFingerprint $rollbackFingerprint)
    }
    try {
      Invoke-DreamSkinCommunityStartAndVerify `
        -OperationLockTimeoutMilliseconds $OperationLockTimeoutMilliseconds
    } catch {
      $rollbackStartFailure = $_
      try {
        $rollbackState = Get-DreamSkinCommunityActiveState -Paths $Paths `
          -StateRoot $StateRoot `
          -OperationLockTimeoutMilliseconds $OperationLockTimeoutMilliseconds
      } catch {
        throw (New-DreamSkinCommunityApplyException `
          -Message 'Another theme action superseded rollback verification.' `
          -Recovery 'Superseded' -InnerException $rollbackStartFailure.Exception)
      }
      if ($rollbackState.Paused -or -not $rollbackState.Readable -or
        $rollbackState.Fingerprint -cne $rollbackFingerprint) {
        throw (New-DreamSkinCommunityApplyException `
          -Message 'Another theme action superseded the restored theme; its choice was not overwritten.' `
          -Recovery 'Superseded' -InnerException $rollbackStartFailure.Exception)
      }
      throw (New-DreamSkinCommunityApplyException `
        -Message ("The imported theme could not be written. The previous active-theme files were " +
          "restored, but their renderer could not be verified: $($rollbackStartFailure.Exception.Message)") `
        -Recovery 'Failed' -InnerException $writeFailure.Exception `
        -RollbackSnapshot $snapshotRoot -RollbackFingerprint $rollbackFingerprint)
    }
    try {
      $rollbackState = Get-DreamSkinCommunityActiveState -Paths $Paths `
        -StateRoot $StateRoot `
        -OperationLockTimeoutMilliseconds $OperationLockTimeoutMilliseconds
    } catch {
      throw (New-DreamSkinCommunityApplyException `
        -Message 'Another theme action superseded rollback verification.' `
        -Recovery 'Superseded' -InnerException $writeFailure.Exception)
    }
    if ($rollbackState.Paused -or -not $rollbackState.Readable -or
      $rollbackState.Fingerprint -cne $rollbackFingerprint) {
      throw (New-DreamSkinCommunityApplyException `
        -Message 'Another theme action superseded the restored theme; its choice was not overwritten.' `
        -Recovery 'Superseded' -InnerException $writeFailure.Exception)
    }
    throw (New-DreamSkinCommunityApplyException `
      -Message 'The imported theme could not be written. The previous theme was reapplied and visibly verified.' `
      -Recovery 'Verified' -InnerException $writeFailure.Exception)
  }

  try {
    Invoke-DreamSkinCommunityStartAndVerify `
      -OperationLockTimeoutMilliseconds $OperationLockTimeoutMilliseconds
  } catch {
    $startFailure = $_
    $appearanceRecovery = "$($startFailure.Exception.Data['DreamSkinAppearanceRecovery'])"
    $startStateUnconfirmed = [bool]$startFailure.Exception.Data['DreamSkinStartStateUnconfirmed'] -or
      $appearanceRecovery -in @('retained', 'blocked', 'preserved-rendered')
    if ($startStateUnconfirmed) {
      throw (New-DreamSkinCommunityApplyException `
        -Message ("The imported theme start state is unconfirmed and was preserved without " +
          "rewriting active-theme files: $($startFailure.Exception.Message)") `
        -Recovery 'Failed' -InnerException $startFailure.Exception `
        -RollbackSnapshot $snapshotRoot -RollbackFingerprint $rollbackFingerprint)
    }
    $superseded = $false
    $rollbackFailure = $null
    $rollbackLock = $null
    try {
      $rollbackLock = Enter-DreamSkinOperationLock `
        -TimeoutMilliseconds $OperationLockTimeoutMilliseconds
    } catch {
      throw (New-DreamSkinCommunityApplyException `
        -Message ("The imported theme failed visible verification, and the operation lock " +
          "could not be reacquired for recovery: $($_.Exception.Message)") `
        -Recovery 'Failed' -InnerException $startFailure.Exception `
        -RollbackSnapshot $snapshotRoot -RollbackFingerprint $rollbackFingerprint)
    }
    try {
      if (Test-DreamSkinPaused -StateRoot $StateRoot) {
        $superseded = $true
      } else {
        try {
          $currentFingerprint = Get-DreamSkinThemeRuntimeContentFingerprint `
            -ThemeDirectory $Paths.Active
        } catch {
          $superseded = $true
        }
      }
      if (-not $superseded -and $currentFingerprint -cne $expectedFingerprint) {
        $superseded = $true
      }
      if (-not $superseded) {
        try {
          $null = Restore-DreamSkinActiveThemeSnapshot -SnapshotDirectory $snapshotRoot `
            -StateRoot $StateRoot -ExpectedContentFingerprint $rollbackFingerprint
        } catch {
          $rollbackFailure = $_
        }
      }
    } finally {
      Exit-DreamSkinOperationLock -Mutex $rollbackLock
    }
    if ($superseded) {
      throw (New-DreamSkinCommunityApplyException `
        -Message 'Another theme or pause action changed the active state; its choice was not overwritten.' `
        -Recovery 'Superseded' -InnerException $startFailure.Exception)
    }
    if ($null -ne $rollbackFailure) {
      throw (New-DreamSkinCommunityApplyException `
        -Message ("The imported theme failed visible verification, and the previous active-theme " +
          "files could not be restored: $($rollbackFailure.Exception.Message)") `
        -Recovery 'Failed' -InnerException $startFailure.Exception `
        -RollbackSnapshot $snapshotRoot -RollbackFingerprint $rollbackFingerprint)
    }
    try {
      Invoke-DreamSkinCommunityStartAndVerify `
        -OperationLockTimeoutMilliseconds $OperationLockTimeoutMilliseconds
    } catch {
      $restoredStartFailure = $_
      try {
        $restoredState = Get-DreamSkinCommunityActiveState -Paths $Paths `
          -StateRoot $StateRoot `
          -OperationLockTimeoutMilliseconds $OperationLockTimeoutMilliseconds
      } catch {
        throw (New-DreamSkinCommunityApplyException `
          -Message 'Another theme action superseded recovery verification.' `
          -Recovery 'Superseded' -InnerException $restoredStartFailure.Exception)
      }
      if ($restoredState.Paused -or -not $restoredState.Readable -or
        $restoredState.Fingerprint -cne $rollbackFingerprint) {
        throw (New-DreamSkinCommunityApplyException `
          -Message 'Another theme action superseded recovery; its choice was not overwritten.' `
          -Recovery 'Superseded' -InnerException $restoredStartFailure.Exception)
      }
      throw (New-DreamSkinCommunityApplyException `
        -Message ("The imported theme failed visible verification. The previous active-theme files " +
          "were restored, but their renderer could not be verified: $($restoredStartFailure.Exception.Message)") `
        -Recovery 'Failed' -InnerException $startFailure.Exception `
        -RollbackSnapshot $snapshotRoot -RollbackFingerprint $rollbackFingerprint)
    }
    try {
      $restoredState = Get-DreamSkinCommunityActiveState -Paths $Paths `
        -StateRoot $StateRoot `
        -OperationLockTimeoutMilliseconds $OperationLockTimeoutMilliseconds
    } catch {
      throw (New-DreamSkinCommunityApplyException `
        -Message 'Another theme action superseded recovery verification.' `
        -Recovery 'Superseded' -InnerException $startFailure.Exception)
    }
    if ($restoredState.Paused -or -not $restoredState.Readable -or
      $restoredState.Fingerprint -cne $rollbackFingerprint) {
      throw (New-DreamSkinCommunityApplyException `
        -Message 'Another theme action superseded recovery; its choice was not overwritten.' `
        -Recovery 'Superseded' -InnerException $startFailure.Exception)
    }
    throw (New-DreamSkinCommunityApplyException `
      -Message ("The imported theme failed visible verification: $($startFailure.Exception.Message) " +
        'The previous theme was reapplied and visibly verified.') `
      -Recovery 'Verified' -InnerException $startFailure.Exception)
  }

  try {
    $successState = Get-DreamSkinCommunityActiveState -Paths $Paths `
      -StateRoot $StateRoot `
      -OperationLockTimeoutMilliseconds $OperationLockTimeoutMilliseconds
  } catch {
    throw (New-DreamSkinCommunityApplyException `
      -Message 'Another theme action superseded final one-click verification.' `
      -Recovery 'Superseded' -InnerException $null)
  }
  if ($successState.Paused -or -not $successState.Readable -or
    $successState.Fingerprint -cne $expectedFingerprint) {
    throw (New-DreamSkinCommunityApplyException `
      -Message 'Another theme or pause action superseded one-click apply; its choice was not overwritten.' `
      -Recovery 'Superseded' -InnerException $null)
  }
  return [pscustomobject]@{ ContentFingerprint = $successState.Fingerprint }
}
