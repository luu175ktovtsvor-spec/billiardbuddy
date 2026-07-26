param(
  [Parameter(Mandatory = $true)]
  [string]$Installer
)

$ErrorActionPreference = 'Stop'
$installerPath = (Resolve-Path -LiteralPath $Installer).Path
$tempBase = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$tempRoot = Join-Path $tempBase "billiardbuddy-package-acceptance-$([Guid]::NewGuid().ToString('N'))"
$installDir = Join-Path $tempRoot 'installed'
$configDir = Join-Path $tempRoot 'config'
$userDataDir = Join-Path $tempRoot 'user-data'
$smokeLog = Join-Path $tempRoot 'window-smoke.jsonl'
$appPath = Join-Path $installDir 'BilliardBuddy.exe'
$appProcess = $null
$installed = $false
$mainError = $null
$cleanupError = $null
$acceptanceEnv = @{
  BILLIARDBUDDY_CONFIG_DIR = $configDir
  BB_ELECTRON_DISABLE_SINGLE_INSTANCE_LOCK = '1'
  BB_ELECTRON_WINDOW_SMOKE_LOG = $smokeLog
  BB_GATEWAY_BOOTSTRAP_CREDENTIAL = 'smoke-invalid-bootstrap'
  BB_LICENSE_KEY = 'smoke-invalid-license'
}
$previousEnv = @{}
foreach ($name in $acceptanceEnv.Keys) {
  $previousEnv[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

function Assert-ReadyProductWindow {
  if (-not (Test-Path -LiteralPath $smokeLog -PathType Leaf)) { return $false }
  $snapshots = @(Get-Content -LiteralPath $smokeLog | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
  if (-not ($snapshots | Where-Object { $_.reason -eq 'did-finish-load' })) { return $false }
  if ($snapshots | Where-Object { $_.reason -in @('backend-failed', 'backend-initialization-failed') }) {
    throw 'Windows 安装后的本地产品后端启动失败'
  }
  if (-not ($snapshots | Where-Object { $_.reason -eq 'backend-ready' })) { return $false }
  $final = @($snapshots | Where-Object { $_.reason -eq 'after-final-show' } | Select-Object -Last 1)
  if ($final.Count -ne 1) { return $false }
  if ($final[0].destroyed -ne $false -or $final[0].visible -ne $true -or $final[0].minimized -ne $false) {
    throw '安装后的桌面窗口未正常显示'
  }
  if ($final[0].title -ne 'BilliardBuddy' -or $final[0].url -notlike '*/dist/index.html*') {
    throw '安装后的桌面窗口未加载正式 BilliardBuddy renderer'
  }
  return $true
}

try {
  New-Item -ItemType Directory -Force $tempRoot, $configDir, $userDataDir | Out-Null
  $installerProcess = Start-Process -FilePath $installerPath -ArgumentList @('/S', "/D=$installDir") -PassThru -Wait
  if ($installerProcess.ExitCode -ne 0) { throw "Windows 安装程序退出码为 $($installerProcess.ExitCode)" }
  if (-not (Test-Path -LiteralPath $appPath -PathType Leaf)) { throw 'Windows 安装后缺少 BilliardBuddy.exe' }
  $installed = $true

  Push-Location (Join-Path $PSScriptRoot '..')
  try {
    bun run audit:package -- --platform win32 --resources (Join-Path $installDir 'resources')
    if ($LASTEXITCODE -ne 0) { throw 'Windows 安装目录成品审计失败' }
  } finally {
    Pop-Location
  }

  foreach ($name in $acceptanceEnv.Keys) {
    [Environment]::SetEnvironmentVariable($name, $acceptanceEnv[$name], 'Process')
  }
  $appProcess = Start-Process -FilePath $appPath -ArgumentList "--user-data-dir=$userDataDir" -PassThru

  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline) {
    if (Assert-ReadyProductWindow) { break }
    if ($appProcess.HasExited) { throw "BilliardBuddy 提前退出: $($appProcess.ExitCode)" }
    Start-Sleep -Milliseconds 250
  }
  if (-not (Assert-ReadyProductWindow)) { throw '安装后的桌面窗口未在 60 秒内就绪' }
  Write-Host (@{ accepted = $true; package = (Split-Path $installerPath -Leaf); installedCopy = $true } | ConvertTo-Json -Compress)
} catch {
  $mainError = $_
} finally {
  if ($appProcess -and -not $appProcess.HasExited) {
    try {
      & taskkill /PID $appProcess.Id /T /F | Out-Null
      if ($LASTEXITCODE -ne 0 -and -not $appProcess.HasExited) {
        throw "无法终止 BilliardBuddy 进程树: $LASTEXITCODE"
      }
    } catch {
      if ($null -eq $cleanupError) { $cleanupError = $_ }
    }
  }

  if ($installed) {
    try {
      $uninstallers = @(Get-ChildItem -LiteralPath $installDir -Filter 'Uninstall*.exe' -File -ErrorAction SilentlyContinue)
      if ($uninstallers.Count -ne 1) { throw 'Windows 安装目录没有唯一卸载程序' }
      $uninstallerProcess = Start-Process -FilePath $uninstallers[0].FullName -ArgumentList '/S' -PassThru -Wait
      if ($uninstallerProcess.ExitCode -ne 0) { throw "Windows 卸载程序退出码为 $($uninstallerProcess.ExitCode)" }
      $uninstallDeadline = (Get-Date).AddSeconds(30)
      while ((Get-Date) -lt $uninstallDeadline -and (Test-Path -LiteralPath $appPath -PathType Leaf)) {
        Start-Sleep -Milliseconds 250
      }
      if (Test-Path -LiteralPath $appPath -PathType Leaf) { throw 'Windows 静默卸载后 BilliardBuddy.exe 仍然存在' }
    } catch {
      if ($null -eq $cleanupError) { $cleanupError = $_ }
    }
  }

  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  foreach ($name in $acceptanceEnv.Keys) {
    [Environment]::SetEnvironmentVariable($name, $previousEnv[$name], 'Process')
  }
}

if ($null -ne $mainError) { throw $mainError }
if ($null -ne $cleanupError) { throw $cleanupError }
