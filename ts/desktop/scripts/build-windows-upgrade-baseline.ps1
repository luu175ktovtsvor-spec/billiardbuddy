param(
  [Parameter(Mandatory = $true)]
  [string]$MediaSourceDir
)

$ErrorActionPreference = 'Stop'
$baselineCommit = '2a6e79846a49f45a24080a9b50e93a7c66c12e61'
$tempBase = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$oldRoot = Join-Path $tempBase 'billiardbuddy-old-0.4.9'
$oldMedia = Join-Path $tempBase 'billiardbuddy-old-0.4.9-media'
$oldInstallerDir = Join-Path $tempBase 'billiardbuddy-old-0.4.9-installer'
$mediaSource = (Resolve-Path -LiteralPath $MediaSourceDir).Path
if ((Test-Path -LiteralPath $oldRoot) -or (Test-Path -LiteralPath $oldMedia) -or (Test-Path -LiteralPath $oldInstallerDir)) {
  throw 'Windows 最老支持版本构建目录已存在'
}

& git worktree add --detach $oldRoot $baselineCommit
if ($LASTEXITCODE -ne 0) { throw '无法创建 Windows 最老支持版本 worktree' }

New-Item -ItemType Directory -Force $oldMedia | Out-Null
foreach ($file in @('ffmpeg.exe', 'ffprobe.exe', 'LICENSE.txt')) {
  $source = Join-Path $mediaSource $file
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Windows 媒体工具链缺少 $file" }
  Copy-Item -LiteralPath $source -Destination (Join-Path $oldMedia $file)
}
$sourceManifestPath = Join-Path $mediaSource 'media-toolchain-source.json'
if (-not (Test-Path -LiteralPath $sourceManifestPath -PathType Leaf)) { throw 'Windows 媒体工具链缺少来源清单' }
$sourceManifest = Get-Content -LiteralPath $sourceManifestPath -Raw | ConvertFrom-Json
$oldManifest = @{
  schemaVersion = 1
  version = $sourceManifest.version
  license = $sourceManifest.license
  sourceUrl = $sourceManifest.sourceUrl
  licenseSha256 = (Get-FileHash -Algorithm SHA256 (Join-Path $oldMedia 'LICENSE.txt')).Hash.ToLowerInvariant()
  files = @{
    'ffmpeg.exe' = (Get-FileHash -Algorithm SHA256 (Join-Path $oldMedia 'ffmpeg.exe')).Hash.ToLowerInvariant()
    'ffprobe.exe' = (Get-FileHash -Algorithm SHA256 (Join-Path $oldMedia 'ffprobe.exe')).Hash.ToLowerInvariant()
  }
}
$oldManifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $oldMedia 'media-toolchain-source.json') -Encoding utf8NoBOM

Push-Location (Join-Path $oldRoot 'ts')
try {
  & bun install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { throw 'Windows 最老支持版本内核依赖安装失败' }
} finally {
  Pop-Location
}

$oldDesktop = Join-Path $oldRoot 'ts\desktop'
Push-Location $oldDesktop
try {
  & bun install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { throw 'Windows 最老支持版本桌面依赖安装失败' }
  New-Item -ItemType Directory -Force (Join-Path $oldDesktop 'build') | Out-Null
  @{ gatewayToken = 'UPGRADE_ACCEPTANCE_ONLY_049' } |
    ConvertTo-Json -Compress |
    Set-Content -LiteralPath (Join-Path $oldDesktop 'build\product-secrets.json') -Encoding utf8NoBOM
  $previousMediaSource = $env:BB_MEDIA_TOOLCHAIN_SOURCE_DIR
  try {
    $env:BB_MEDIA_TOOLCHAIN_SOURCE_DIR = $oldMedia
    & bun run electron:package
    if ($LASTEXITCODE -ne 0) { throw 'Windows 最老支持版本安装包构建失败' }
  } finally {
    $env:BB_MEDIA_TOOLCHAIN_SOURCE_DIR = $previousMediaSource
  }
} finally {
  Pop-Location
}

$installers = @(Get-ChildItem -LiteralPath (Join-Path $oldDesktop 'build-artifacts\electron') -Filter '*.exe' -File)
if ($installers.Count -ne 1) { throw 'Windows 最老支持版本没有生成唯一安装包' }
New-Item -ItemType Directory -Force $oldInstallerDir | Out-Null
$persistedInstaller = Join-Path $oldInstallerDir $installers[0].Name
Copy-Item -LiteralPath $installers[0].FullName -Destination $persistedInstaller
& git worktree remove --force $oldRoot
if ($LASTEXITCODE -ne 0) { throw 'Windows 最老支持版本构建后无法释放 worktree' }
Remove-Item -LiteralPath $oldMedia -Recurse -Force
if (-not $env:GITHUB_ENV) { throw '缺少 GITHUB_ENV，无法传递 Windows 最老支持安装包' }
"BB_OLD_WINDOWS_INSTALLER=$persistedInstaller" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
Write-Host (@{ baselineCommit = $baselineCommit; installer = $persistedInstaller } | ConvertTo-Json -Compress)
