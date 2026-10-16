[CmdletBinding()]
param(
  [int]$Port = 9335,
  [switch]$Uninstall,
  [switch]$RestoreBaseTheme,
  [switch]$RecoverConfigBackup,
  [switch]$PromptRestart,
  [switch]$ForceRestart,
  [switch]$NoRelaunch,
  [string]$ManagerRequestPath,
  [string]$ManagerApplicationRoot,
  [ValidatePattern('^[a-f0-9]{64}$')][string]$ManagerPrecondition,
  [System.Collections.IDictionary]$ManagerEffects
)

$ErrorActionPreference = 'Stop'
$PortExplicit = $PSBoundParameters.ContainsKey('Port')
. (Join-Path $PSScriptRoot 'common-windows.ps1')
. (Join-Path $PSScriptRoot 'theme-windows.ps1')
. (Join-Path $PSScriptRoot 'localization-windows.ps1')

$operationLock = Enter-DreamSkinOperationLock
try {
  if ($ManagerRequestPath -and (-not $ManagerApplicationRoot -or -not $ManagerPrecondition -or $null -eq $ManagerEffects -or
      -not $RestoreBaseTheme -or $RecoverConfigBackup -or $Uninstall -or $NoRelaunch -or -not $ForceRestart)) { throw 'Invalid shared restore invocation.' }
  if ($RestoreBaseTheme -and $RecoverConfigBackup) {
    throw 'Choose either -RestoreBaseTheme or -RecoverConfigBackup, not both.'
  }
  Assert-DreamSkinPort -Port $Port

  $StateRoot = Join-Path $env:LOCALAPPDATA 'CodexDreamSkin'
  $language = Resolve-DreamSkinLanguage -StateRoot $StateRoot
  $themePaths = Get-DreamSkinThemePaths -StateRoot $StateRoot
  Ensure-DreamSkinManagedDirectory -Path $themePaths.Root -Root $themePaths.Root
  $StatePath = Join-Path $StateRoot 'state.json'
  $state = Read-DreamSkinState -Path $StatePath
  if (-not $PortExplicit -and $null -ne $state -and $state.port) {
    $Port = [int]$state.port
    Assert-DreamSkinPort -Port $Port
  }

  $currentCodex = $null
  try { $currentCodex = Get-DreamSkinCodexInstall } catch { Write-Warning $_.Exception.Message }
  $savedPathCandidate = Get-DreamSkinCodexStatePathCandidate -State $state
  $savedCodex = Get-DreamSkinCodexInstallFromState -State $state
  $candidateMatchesCurrent = [bool]($null -ne $savedPathCandidate -and $null -ne $currentCodex -and
    (Test-DreamSkinPathEqual -Left $savedPathCandidate.PackageRoot -Right $currentCodex.PackageRoot) -and
    (Test-DreamSkinPathEqual -Left $savedPathCandidate.Executable -Right $currentCodex.Executable))
  if ($null -ne $savedPathCandidate -and $null -eq $savedCodex -and -not $candidateMatchesCurrent) {
    $unverifiedSavedRunning = (Get-DreamSkinCodexProcesses -Codex $savedPathCandidate).Count -gt 0
    $unverifiedSavedOwnsPort = Test-DreamSkinCodexPortOwner -Port $Port -Codex $savedPathCandidate
    if ($unverifiedSavedRunning -or $unverifiedSavedOwnsPort) {
      throw 'The saved Codex path is still active but no longer matches a registered OpenAI Codex/ChatGPT package. Close it manually; state and configuration were preserved.'
    }
  }
  $savedIsDifferent = [bool]($null -ne $savedCodex -and $null -ne $currentCodex -and
    -not (Test-DreamSkinPathEqual -Left $savedCodex.Executable -Right $currentCodex.Executable))
  $currentRunning = $null -ne $currentCodex -and (Get-DreamSkinCodexProcesses -Codex $currentCodex).Count -gt 0
  $savedRunning = $null -ne $savedCodex -and (Get-DreamSkinCodexProcesses -Codex $savedCodex).Count -gt 0
  $savedOwnsPort = $null -ne $savedCodex -and (Test-DreamSkinCodexPortOwner -Port $Port -Codex $savedCodex)
  if ($savedIsDifferent -and $currentRunning -and ($savedRunning -or $savedOwnsPort)) {
    throw 'Multiple Codex package versions are active. Close them manually before restore; state and configuration were preserved.'
  }

  $codex = $currentCodex
  if ($savedRunning -or $savedOwnsPort -or $null -eq $currentCodex) {
    $codex = $savedCodex
    if ($null -ne $codex -and $savedIsDifferent) {
      Write-Warning 'Using the saved Codex package identity to close its older active CDP session.'
    } elseif ($null -ne $codex -and $null -eq $currentCodex) {
      Write-Warning 'Using the saved Codex identity after revalidating it against the registered Store package.'
    }
  }
  $relaunchCodex = if ($null -ne $currentCodex) { $currentCodex } else { $codex }
  $codexRunning = $null -ne $codex -and (Get-DreamSkinCodexProcesses -Codex $codex).Count -gt 0
  $portOwnedByCodex = $null -ne $codex -and (Test-DreamSkinCodexPortOwner -Port $Port -Codex $codex)
  if ($portOwnedByCodex -and -not $codexRunning) {
    throw 'A Codex-owned listener exists without a manageable Codex process; state was preserved.'
  }
  if ($null -ne $state -and $null -eq $codex -and -not (Test-DreamSkinPortAvailable -Port $Port)) {
    throw "Port $Port is still active, but Codex ownership cannot be verified. State and configuration were preserved."
  }

  $shouldCloseCodex = $codexRunning
  $forceAuthorized = [bool]$ForceRestart
  if ($shouldCloseCodex -and $PromptRestart) {
    $restartMessage = if ($NoRelaunch) {
      Get-DreamSkinText -Key 'RestoreCloseNoRelaunch' -Language $language
    } else {
      Get-DreamSkinText -Key 'RestoreClose' -Language $language
    }
    $forceAuthorized = Confirm-DreamSkinRestart -Message $restartMessage
    if (-not $forceAuthorized) {
      Write-Host (Get-DreamSkinText -Key 'RestoreCancelled' -Language $language)
      exit 0
    }
  }

  $backup = Join-Path $StateRoot 'config.before-dream-skin.toml'
  $config = Join-Path $HOME '.codex\config.toml'
  if ($RecoverConfigBackup) {
    if (-not (Test-Path -LiteralPath $backup)) { throw 'No pre-install config backup is available.' }
    $null = Read-DreamSkinUtf8File -Path $backup
  } elseif ($RestoreBaseTheme) {
    if (-not (Test-Path -LiteralPath $backup)) { throw 'No pre-install config backup is available.' }
    $null = Read-DreamSkinUtf8File -Path $backup
    $null = Read-DreamSkinUtf8File -Path $config
  }

  $restoreError = $null
  try {
    if ($ManagerRequestPath) {
      # The caller owns the same reentrant operation mutex. Recheck consent at
      # the process boundary, then separately bind config after closing Codex.
      $managerNode = Join-Path $ManagerApplicationRoot 'runtime\node\node.exe'
      $managerWorker = Join-Path $ManagerApplicationRoot 'shared\core\runtime-worker.mjs'
      $restoreProbe = & (Join-Path $PSScriptRoot 'manager-platform.ps1') -Action Probe -ApplicationRoot $ManagerApplicationRoot
      $restoreProbe = ($restoreProbe -join "`n") | ConvertFrom-Json
      if ($restoreProbe.fingerprint -cne $ManagerPrecondition) { throw 'The confirmed restore process/session changed.' }
      $restoreProbe64 = 'base64:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($restoreProbe | ConvertTo-Json -Depth 10 -Compress)))
      $null = & $managerNode $managerWorker check $ManagerApplicationRoot $restoreProbe64 $ManagerRequestPath
      if ($LASTEXITCODE -ne 0) { throw 'The confirmed restore inputs changed.' }
      $null = Restore-DreamSkinBaseTheme -ConfigPath $config -BackupPath $backup -VerifyOnly
      if (Test-DreamSkinPendingAppearanceTransaction -BackupPath $backup) { throw 'An unfinished appearance transaction requires recovery before selective restore.' }
      $ManagerEffects.runtimeDetached = $null
      $ManagerEffects.rendererRemoved = $null
      $ManagerEffects.rendererApplied = $null
      if ($shouldCloseCodex) { $ManagerEffects.codexRestarted = $null }
    }
    if ($shouldCloseCodex) {
      Stop-DreamSkinCodex -Codex $codex -AllowForce:$forceAuthorized
      if ($portOwnedByCodex -and -not (Wait-DreamSkinPortAvailable -Port $Port -TimeoutSeconds 5)) {
        throw "Port $Port is still listening after Codex closed; state was preserved for inspection."
      }
    }

    $recordedInjectorStopped = Stop-DreamSkinRecordedInjector -State $state
    if ($ManagerRequestPath -and -not $recordedInjectorStopped) { throw 'The recorded injector could not be stopped safely; configuration was preserved.' }
    if (-not $recordedInjectorStopped) {
      $staleStatePath = Archive-DreamSkinStateFile -Path $StatePath
      Write-Warning "Archived stale Dream Skin state at $staleStatePath"
    }

    if ($RecoverConfigBackup) {
      $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss-fff') + '-' + [guid]::NewGuid().ToString('N')
      $recoveryBackup = Join-Path $StateRoot "config.before-recovery-$stamp.toml"
      Restore-DreamSkinConfigBackup -ConfigPath $config -BackupPath $backup -RecoveryBackupPath $recoveryBackup
      Write-Host "Recovered the exact pre-install config; previous current config saved at $recoveryBackup"
    } elseif ($RestoreBaseTheme) {
      if ($ManagerRequestPath) {
        $null = & $managerNode $managerWorker check-appearance $ManagerApplicationRoot '{}' $ManagerRequestPath
        if ($LASTEXITCODE -ne 0) { throw 'The confirmed appearance config or backup changed.' }
        $ManagerEffects.appearanceRestored = $null
      }
      Restore-DreamSkinBaseTheme -ConfigPath $config -BackupPath $backup
      if ($ManagerRequestPath) {
        if (-not (Restore-DreamSkinBaseTheme -ConfigPath $config -BackupPath $backup -VerifyOnly)) { throw 'The selective appearance readback did not match.' }
        $ManagerEffects.appearanceRestored = $true
      }
    }
    if ($RecoverConfigBackup -or $RestoreBaseTheme) {
      $archiveStamp = (Get-Date).ToString('yyyyMMdd-HHmmss-fff') + '-' + [guid]::NewGuid().ToString('N')
      $archivePath = Join-Path $StateRoot "config.restored-$archiveStamp.toml"
      if ($ManagerRequestPath) { $ManagerEffects.backupArchived = $null }
      Archive-DreamSkinConfigBackup -BackupPath $backup -ArchivePath $archivePath
      if ($ManagerRequestPath) { $ManagerEffects.backupArchived = [bool]((Test-Path -LiteralPath $archivePath -PathType Leaf) -and -not (Test-Path -LiteralPath $backup)) }
      Write-Host "Archived the completed pre-install backup at $archivePath"
    }

    Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $StateRoot 'paused') -Force -ErrorAction SilentlyContinue
    if ($ManagerRequestPath) {
      if ((Test-Path -LiteralPath $StatePath) -or (Test-Path -LiteralPath (Join-Path $StateRoot 'paused')) -or
          -not (Test-DreamSkinPortAvailable -Port $Port)) { throw 'The skin session could not be detached safely.' }
      $ManagerEffects.runtimeDetached = $true
    }

    if ($shouldCloseCodex -and -not $NoRelaunch) {
      if ($null -eq $relaunchCodex -or -not (Test-Path -LiteralPath $relaunchCodex.Executable)) {
        throw 'Codex cannot be reopened because its current executable is unavailable.'
      }
      $null = Start-DreamSkinCodex -Codex $relaunchCodex
      if ($ManagerRequestPath -and (Get-DreamSkinCodexProcesses -Codex $relaunchCodex).Count -gt 0) { $ManagerEffects.codexRestarted = $true }
    }
  } catch {
    $restoreError = $_
    if ($shouldCloseCodex -and -not $NoRelaunch -and $null -ne $relaunchCodex -and
      (Get-DreamSkinCodexProcesses -Codex $codex).Count -eq 0 -and (Test-Path -LiteralPath $relaunchCodex.Executable)) {
      try { $null = Start-DreamSkinCodex -Codex $relaunchCodex } catch {
        Write-Warning 'Restore failed and Codex could not be reopened automatically.'
      }
    }
    throw $restoreError
  }

  Write-Host 'Dream Skin restore actions completed; any saved CDP session was closed.'
} finally {
  Exit-DreamSkinOperationLock -Mutex $operationLock
}
