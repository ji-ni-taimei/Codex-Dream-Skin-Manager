# Private Windows status/publication primitives used by the shared manager.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('Status','ApplyTheme')][string]$Action,
  [Parameter(Mandatory = $true)][string]$SkillRoot,
  [string]$StateRoot = (Join-Path $env:LOCALAPPDATA 'CodexDreamSkin'),
  [string]$ThemeDirectory,
  [switch]$DeferLiveApply
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common-windows.ps1')
. (Join-Path $PSScriptRoot 'theme-windows.ps1')
. (Join-Path $PSScriptRoot 'runtime-version.ps1')
$paths = Get-DreamSkinThemePaths -StateRoot $StateRoot

function Get-ManagerInjectorStatus {
  param([AllowNull()][object]$State)
  if ($null -eq $State) {
    return [pscustomobject]@{ Kind = 'stopped'; Message = '未检测到皮肤注入器。'; Running = $false }
  }
  if (-not $State.injectorPid) {
    if ($State.connectionOnly -is [bool] -and $State.connectionOnly) {
      return [pscustomobject]@{ Kind = 'stopped'; Message = 'Codex 已连接，皮肤尚未启用。'; Running = $false }
    }
    return [pscustomobject]@{ Kind = 'stale'; Message = '状态文件缺少注入器进程编号。'; Running = $false }
  }

  $processId = [int]$State.injectorPid
  $visibleProcess = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if (-not $visibleProcess) {
    return [pscustomobject]@{ Kind = 'stale'; Message = "记录的注入器进程已不存在（PID $processId）。"; Running = $false }
  }
  # A restart can reuse the old injector's PID for an unrelated process.
  # A readable, different start time proves the saved watcher has ended; it
  # does not indicate an unsafe live injector that needs forced recovery.
  $currentStartedAt = Get-DreamSkinProcessStartedAt -ProcessId $processId
  if ($currentStartedAt -and $State.injectorStartedAt) {
    if ((Test-DreamSkinTimestampEqual -Left $State.injectorStartedAt -Right $State.injectorStartedAt) -and
      -not (Test-DreamSkinTimestampEqual -Left $currentStartedAt -Right $State.injectorStartedAt)) {
      return [pscustomobject]@{
        Kind = 'stale'
        Message = "原皮肤注入器已结束，PID $processId 已由其他进程使用；可重新应用皮肤。"
        Running = $false
      }
    }
  }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -OperationTimeoutSec 3 -ErrorAction SilentlyContinue
  if (-not $process) {
    return [pscustomobject]@{ Kind = 'uninspectable'; Message = "进程存在，但系统不允许核验其命令行（PID $processId）。"; Running = $false }
  }

  $expectedInjector = if ($State.injectorPath) {
    "$($State.injectorPath)"
  } elseif ($State.skillRoot) {
    Join-Path "$($State.skillRoot)" 'scripts\injector.mjs'
  } else { $null }
  $runtimeCurrent = $true
  if ($State.runtimeFingerprint) {
    $runtimeCurrent = Test-DreamSkinRuntimeCurrent -SkillRoot $SkillRoot -RecordedInjectorPath $expectedInjector `
      -RecordedFingerprint "$($State.runtimeFingerprint)"
  }
  if (-not $runtimeCurrent) {
    return [pscustomobject]@{
      Kind = 'stale'
      Message = '皮肤运行时已更新，需要重新应用后才能使用新功能。'
      Running = $false
    }
  }
  $processPath = Get-DreamSkinProcessExecutablePath -ProcessInfo $process
  $commandLine = "$($process.CommandLine)"
  if (-not $processPath -or -not $commandLine) {
    # Some Windows installations hide a packaged Node process' path and
    # command line even from the same-user manager.  Keep the live session
    # usable when the PID is still a node process and its recorded start time
    # matches exactly; a reused PID cannot pass this continuity check.
    $continuity = $false
    if ($State.injectorStartedAt -and "$($process.Name)" -ieq 'node.exe') {
      try {
        $startedAt = Get-DreamSkinProcessStartedAt -ProcessId $processId
        $continuity = Test-DreamSkinTimestampEqual -Left $startedAt -Right "$($State.injectorStartedAt)"
      } catch { $continuity = $false }
    }
    if ($continuity) {
      return [pscustomobject]@{
        Kind = 'running'
        Message = "皮肤注入器正在运行（PID $processId；Windows 未提供进程路径，已依据启动时间确认）。"
        Running = $true
      }
    }
    return [pscustomobject]@{ Kind = 'uninspectable'; Message = "无法核验注入器进程身份（PID $processId）。"; Running = $false }
  }

  $matches = [System.IO.Path]::GetFileName("$processPath") -ieq 'node.exe'
  if ($State.nodePath) {
    $matches = $matches -and (Test-DreamSkinPathEqual -Left $processPath -Right "$($State.nodePath)")
  }
  $matches = $matches -and [bool]($expectedInjector -and
    (Test-DreamSkinCommandLineToken -CommandLine $commandLine -Token $expectedInjector) -and
    (Test-DreamSkinCommandLineToken -CommandLine $commandLine -Token '--watch'))
  if ($State.port) {
    $portPattern = '(?i)(?:^|\s)--port(?:=|\s+)' + [regex]::Escape("$($State.port)") + '(?=$|\s)'
    $matches = $matches -and [regex]::IsMatch($commandLine, $portPattern)
  } else { $matches = $false }
  if ($State.browserId) {
    $browserPattern = '(?:^|\s)(?i:--browser-id)(?:=|\s+)' + [regex]::Escape("$($State.browserId)") + '(?=$|\s)'
    $matches = $matches -and [regex]::IsMatch($commandLine, $browserPattern)
  }
  $startedAt = Get-DreamSkinProcessStartedAt -ProcessId $processId
  if ($State.injectorStartedAt) {
    $matches = $matches -and
      (Test-DreamSkinTimestampEqual -Left $startedAt -Right $State.injectorStartedAt)
  }
  if (-not $matches) {
    return [pscustomobject]@{ Kind = 'mismatch'; Message = "PID $processId 存在，但不是记录的 Dream Skin 注入器。"; Running = $false }
  }
  if (-not $State.runtimeFingerprint) {
    return [pscustomobject]@{ Kind = 'uninspectable'; Message = '状态文件缺少运行时指纹，无法确认注入器版本。'; Running = $false }
  }
  return [pscustomobject]@{ Kind = 'running'; Message = "皮肤注入器正在运行（PID $processId）。"; Running = $true }
}

function Invoke-ManagerLiveApplyIfRunning {
  $state = Read-DreamSkinState -Path $paths.State
  $identity = Get-ManagerInjectorStatus -State $state
  # The packaged Node process can be running while Windows hides its command
  # line and executable path. The recorded port/browser pair is independently
  # verified by the renderer probe, so keep using that live session instead
  # of forcing a Codex restart merely because PID identity is uninspectable.
  $hasLiveSession = $null -ne $state -and $state.port -and $state.browserId
  if (-not $identity.Running -and -not $hasLiveSession) { return $false }
  $live = Invoke-DreamSkinLiveApply -StateRoot $StateRoot
  # Only this failure means the theme was committed but the live session did
  # not apply it. Callers may reconcile startup; validation/write errors must
  # keep failing without being mistaken for a recoverable connection race.
  if (-not $live.Applied) { throw "DREAM_SKIN_LIVE_APPLY_FAILED: $($live.Message)" }
  $script:liveVerification = $live.Verification | ConvertFrom-Json
  return $true
}


if ($Action -eq 'Status') {
  $active = $null
  try { $active = Read-DreamSkinTheme -ThemeDirectory $paths.Active -SkipImageMetadata } catch {}
  $state = Read-DreamSkinState -Path $paths.State
  $identity = Get-ManagerInjectorStatus -State $state
  $paused = Test-DreamSkinPaused -StateRoot $StateRoot
  [ordered]@{
    isRunning = [bool]$identity.Running
    isPaused = [bool]$paused
    statusKind = if ($identity.Running -and $paused) { 'paused' } else { $identity.Kind }
    statusMessage = $identity.Message
    activeThemeId = if ($active) { "$($active.Theme.id)" } else { '' }
  } | ConvertTo-Json -Depth 4 -Compress
  return
}
# The platform caller holds the operation lock and supplies a verified snapshot.
$snapshotRoot = Join-Path $StateRoot 'manager-operations\snapshots'
if (-not $ThemeDirectory -or -not (Test-DreamSkinThemePathWithin -Path $ThemeDirectory -Root $snapshotRoot)) {
  throw 'Theme publication requires a manager snapshot.'
}
Initialize-DreamSkinThemeStore -SkillRoot $SkillRoot -StateRoot $StateRoot -PrepareOnly | Out-Null
$saved = Read-DreamSkinTheme -ThemeDirectory $ThemeDirectory -SkipImageMetadata
$css = Join-Path $ThemeDirectory 'theme.css'
if (-not (Test-Path -LiteralPath $css -PathType Leaf)) { $css = $null }
if ($css) { Assert-DreamSkinSafeCssFile -Path $css }
$result = Set-DreamSkinActiveTheme -ImagePath $saved.ImagePath -Theme $saved.Theme -SafeCssPath $css -SkipImageArchive -StateRoot $StateRoot
Set-DreamSkinPaused -Paused $false -StateRoot $StateRoot | Out-Null
$applied = if ($DeferLiveApply) { $false } else { Invoke-ManagerLiveApplyIfRunning }
[ordered]@{ id = "$($result.Theme.id)"; rendererApplied = [bool]$applied; rendererVerification = $script:liveVerification } | ConvertTo-Json -Depth 20 -Compress
