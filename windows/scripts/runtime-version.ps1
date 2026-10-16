function Get-DreamSkinRuntimeFileHash {
  param([Parameter(Mandatory = $true)][string]$Path)

  $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return (($sha.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) -join '')
  } finally {
    $sha.Dispose()
    $stream.Dispose()
  }
}

function Get-DreamSkinRuntimeFingerprint {
  param([Parameter(Mandatory = $true)][string]$SkillRoot)
  try {
    $currentInjector = [System.IO.Path]::GetFullPath((Join-Path $SkillRoot 'scripts\injector.mjs'))
    $baseRuntimeFiles = @(
      $currentInjector,
      (Join-Path $SkillRoot 'assets\renderer-inject.js'),
      (Join-Path $SkillRoot 'assets\dream-skin.css')
    )
    $extendedRuntimeFiles = @(
      (Join-Path $SkillRoot 'assets\selectors.json'),
      (Join-Path $SkillRoot 'assets\safe-css-validator.mjs'),
      (Join-Path $SkillRoot 'assets\theme-package-validator.mjs'),
      (Join-Path $SkillRoot 'scripts\image-metadata.mjs'),
      (Join-Path $SkillRoot 'scripts\video-decode-probe.mjs'),
      (Join-Path $SkillRoot 'scripts\validate-video-file.mjs')
    )
    # Treat the generated validator set as one versioned unit. A legacy engine
    # either has all of it or is fingerprinted by the original three files.
    $runtimeFiles = if (@($extendedRuntimeFiles | Where-Object {
      -not (Test-Path -LiteralPath $_ -PathType Leaf)
    }).Count -eq 0) { $baseRuntimeFiles + $extendedRuntimeFiles } else { $baseRuntimeFiles }
    $sharedEngineFiles = @(
      (Join-Path $SkillRoot 'scripts\cdp-transport.mjs'),
      (Join-Path $SkillRoot 'scripts\injection-engine.mjs'),
      (Join-Path $SkillRoot 'scripts\watcher-engine.mjs'),
      (Join-Path $SkillRoot 'scripts\media-cache.mjs'),
      (Join-Path $SkillRoot 'scripts\theme-payload.mjs'),
      (Join-Path $SkillRoot 'scripts\renderer-session.mjs'),
      (Join-Path $SkillRoot 'scripts\renderer-verification.mjs')
    )
    $injectorSource = [System.IO.File]::ReadAllText($currentInjector)
    $usesSharedEngine = $injectorSource.Contains('from "./cdp-transport.mjs"') -or
      $injectorSource.Contains('from "./injection-engine.mjs"') -or
      $injectorSource.Contains('from "./watcher-engine.mjs"')
    $sharedEnginePresent = @($sharedEngineFiles | Where-Object {
      Test-Path -LiteralPath $_ -PathType Leaf
    }).Count
    if ($usesSharedEngine -or $sharedEnginePresent -gt 0) {
      # A partial shared engine must be stale, never fingerprinted as legacy.
      if ($sharedEnginePresent -ne $sharedEngineFiles.Count) { return '' }
      $runtimeFiles += $sharedEngineFiles
    }
    $componentHashes = @()
    foreach ($runtimeFile in $runtimeFiles) {
      if (-not (Test-Path -LiteralPath $runtimeFile -PathType Leaf)) { return '' }
      $componentHashes += Get-DreamSkinRuntimeFileHash -Path $runtimeFile
    }
    if ($componentHashes.Count -lt 3) { return '' }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
      $bytes = [System.Text.Encoding]::UTF8.GetBytes(($componentHashes -join '|'))
      return (($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join '')
    } finally {
      $sha.Dispose()
    }
  } catch {
    # Runtime files can be replaced or temporarily inaccessible during an update.
    # Treat an unreadable fingerprint as stale instead of failing Status/recovery.
    return ''
  }
}

function Test-DreamSkinRuntimeCurrent {
  param(
    [Parameter(Mandatory = $true)][string]$SkillRoot,
    [Parameter(Mandatory = $true)][string]$RecordedInjectorPath,
    [AllowEmptyString()][string]$RecordedFingerprint = ''
  )

  if ([string]::IsNullOrWhiteSpace($RecordedFingerprint)) { return $false }
  try {
    $recordedInjector = [System.IO.Path]::GetFullPath($RecordedInjectorPath)
    $recordedScripts = [System.IO.Path]::GetDirectoryName($recordedInjector)
    $recordedRoot = [System.IO.Path]::GetDirectoryName($recordedScripts)
    $expectedInjector = [System.IO.Path]::GetFullPath((Join-Path $recordedRoot 'scripts\injector.mjs'))
    if (-not [string]::Equals($recordedInjector, $expectedInjector,
        [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
  } catch {
    return $false
  }
  $currentFingerprint = Get-DreamSkinRuntimeFingerprint -SkillRoot $SkillRoot
  $recordedRuntimeFingerprint = Get-DreamSkinRuntimeFingerprint -SkillRoot $recordedRoot
  return $currentFingerprint -and $recordedRuntimeFingerprint -and
    [string]::Equals($currentFingerprint, $RecordedFingerprint, [System.StringComparison]::OrdinalIgnoreCase) -and
    [string]::Equals($recordedRuntimeFingerprint, $RecordedFingerprint, [System.StringComparison]::OrdinalIgnoreCase)
}
