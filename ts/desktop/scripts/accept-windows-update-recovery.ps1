param(
  [Parameter(Mandatory = $true)]
  [string]$Installer
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-installer-runner.ps1')
$installerPath = (Resolve-Path -LiteralPath $Installer).Path
$desktopDir = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$tempBase = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$tempRoot = Join-Path $tempBase "billiardbuddy-update-recovery-$([Guid]::NewGuid().ToString('N'))"
$installDir = Join-Path $tempRoot 'installed'
$configDir = Join-Path $tempRoot 'config'
$userDataDir = Join-Path $tempRoot 'user-data'
$appPath = Join-Path $installDir 'BilliardBuddy.exe'
$authReadyFile = Join-Path $tempRoot 'auth-gateway.json'
$updateReadyFile = Join-Path $tempRoot 'update-gateway.json'
$allowSignalFile = Join-Path $tempRoot 'allow-update-downloads'
$cacheName = "billiardbuddy-updater-acceptance-$([Guid]::NewGuid().ToString('N'))"
$cacheDir = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA $cacheName } else { $null }
$probeScript = Join-Path $PSScriptRoot 'package-update-renderer-probe.ts'
$appProcess = $null
$authGatewayProcess = $null
$updateGatewayProcess = $null
$installed = $false
$mainError = $null
$cleanupError = $null
$environmentNames = @(
  'BILLIARDBUDDY_CONFIG_DIR',
  'BB_ELECTRON_DISABLE_SINGLE_INSTANCE_LOCK',
  'BB_ELECTRON_WINDOW_SMOKE_LOG',
  'BB_ELECTRON_WINDOW_SMOKE_INCLUDE_ERROR_DETAILS',
  'BB_GATEWAY_URL',
  'BB_GATEWAY_BOOTSTRAP_CREDENTIAL',
  'BB_LICENSE_KEY',
  'NODE_EXTRA_CA_CERTS'
)
$previousEnv = @{}
foreach ($name in $environmentNames) {
  $previousEnv[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

function Stop-ProcessTree {
  param(
    [Parameter(Mandatory = $true)]
    [System.Diagnostics.Process]$Process,
    [Parameter(Mandatory = $true)]
    [string]$Name
  )
  if ($Process.HasExited) { return }
  & taskkill /PID $Process.Id /T /F | Out-Null
  if ($LASTEXITCODE -ne 0 -and -not $Process.HasExited) { throw "无法终止 $Name 进程树: $LASTEXITCODE" }
}

function Get-FreePort {
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  try {
    $listener.Start()
    return ([Net.IPEndPoint]$listener.LocalEndpoint).Port
  } finally {
    $listener.Stop()
  }
}

function Wait-ReadyFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [System.Diagnostics.Process]$Process,
    [Parameter(Mandatory = $true)]
    [string]$Name
  )
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    if ($Process.HasExited) { throw "$Name 提前退出: $($Process.ExitCode)" }
    Start-Sleep -Milliseconds 100
  }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Name 未在 15 秒内就绪" }
}

function Assert-ReadyProductWindow {
  param(
    [Parameter(Mandatory = $true)]
    [string]$SmokeLog
  )
  if (-not (Test-Path -LiteralPath $SmokeLog -PathType Leaf)) { throw '更新恢复验收没有窗口/后端启动证据' }
  $snapshots = @(Get-Content -LiteralPath $SmokeLog | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
  $failure = @($snapshots | Where-Object { $_.reason -in @('backend-failed', 'backend-initialization-failed') } | Select-Object -Last 1)
  if ($failure.Count -eq 1) {
    $failureEvidence = $failure[0] | ConvertTo-Json -Compress -Depth 5
    throw "更新恢复验收的 Product Server 启动失败: $failureEvidence"
  }
  if (-not ($snapshots | Where-Object { $_.reason -eq 'backend-ready' })) {
    throw '更新恢复验收没有进入 backend-ready'
  }
  $final = @($snapshots | Where-Object { $_.reason -eq 'after-final-show' } | Select-Object -Last 1)
  if ($final.Count -ne 1 -or $final[0].visible -ne $true -or $final[0].destroyed -ne $false) {
    throw '更新恢复验收没有显示正式产品窗口'
  }
}

function Invoke-UpdateAttempt {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Expectation,
    [Parameter(Mandatory = $true)]
    [pscustomobject]$AuthGateway,
    [Parameter(Mandatory = $true)]
    [pscustomobject]$UpdateGateway
  )
  $port = Get-FreePort
  $smokeLog = Join-Path $tempRoot "window-smoke-$Expectation.jsonl"
  $environment = @{
    BILLIARDBUDDY_CONFIG_DIR = $configDir
    BB_ELECTRON_DISABLE_SINGLE_INSTANCE_LOCK = '1'
    BB_ELECTRON_WINDOW_SMOKE_LOG = $smokeLog
    BB_ELECTRON_WINDOW_SMOKE_INCLUDE_ERROR_DETAILS = '1'
    BB_GATEWAY_URL = $AuthGateway.url
    BB_GATEWAY_BOOTSTRAP_CREDENTIAL = $AuthGateway.bootstrapCredential
    BB_LICENSE_KEY = $AuthGateway.licenseKey
    NODE_EXTRA_CA_CERTS = $UpdateGateway.caPath
  }
  foreach ($name in $environmentNames) {
    $value = if ($environment.ContainsKey($name)) { $environment[$name] } else { $null }
    [Environment]::SetEnvironmentVariable($name, $value, 'Process')
  }
  $script:appProcess = Start-Process -FilePath $appPath -ArgumentList @(
    "--user-data-dir=$userDataDir",
    "--remote-debugging-port=$port",
    "--ignore-certificate-errors-spki-list=$($UpdateGateway.certificatePin)"
  ) -PassThru
  try {
    $output = @(& bun run $probeScript `
      --port "$port" `
      --expected-version $UpdateGateway.version `
      --expect $Expectation)
    if ($LASTEXITCODE -ne 0) { throw "Windows 更新 $Expectation renderer 验收失败" }
    if (-not ($output | Where-Object { $_ -match '^{' })) { throw 'Windows 更新 renderer 验收没有返回 JSON 结果' }
    Assert-ReadyProductWindow -SmokeLog $smokeLog
  } finally {
    if ($script:appProcess) {
      Stop-ProcessTree -Process $script:appProcess -Name 'BilliardBuddy'
      $script:appProcess = $null
    }
  }
}

try {
  New-Item -ItemType Directory -Force $tempRoot, $configDir, $userDataDir | Out-Null
  $installerProcess = Invoke-BilliardBuddyWindowsInstaller `
    -InstallerPath $installerPath `
    -InstallDir $installDir `
    -TempRoot $tempRoot `
    -FailureLabel 'Windows 安装程序'
  if (-not (Test-Path -LiteralPath $appPath -PathType Leaf)) { throw 'Windows 安装后缺少 BilliardBuddy.exe' }
  $installed = $true

  Push-Location $desktopDir
  try {
    & bun run audit:package -- --platform win32 --resources (Join-Path $installDir 'resources')
    if ($LASTEXITCODE -ne 0) { throw 'Windows 更新恢复安装目录成品审计失败' }
  } finally {
    Pop-Location
  }

  $authGatewayProcess = Start-Process -FilePath 'bun' -ArgumentList @(
    'run',
    (Join-Path $PSScriptRoot 'package-auth-gateway.ts'),
    '--ready-file',
    $authReadyFile
  ) -WorkingDirectory $desktopDir -PassThru -NoNewWindow
  Wait-ReadyFile -Path $authReadyFile -Process $authGatewayProcess -Name '本地安装包激活服务'
  $authGateway = Get-Content -LiteralPath $authReadyFile -Raw | ConvertFrom-Json

  $updateGatewayProcess = Start-Process -FilePath 'bun' -ArgumentList @(
    'run',
    (Join-Path $PSScriptRoot 'package-update-gateway.ts'),
    '--artifact',
    $installerPath,
    '--platform',
    'win',
    '--ready-file',
    $updateReadyFile,
    '--allow-signal-file',
    $allowSignalFile
  ) -WorkingDirectory $desktopDir -PassThru -NoNewWindow
  Wait-ReadyFile -Path $updateReadyFile -Process $updateGatewayProcess -Name '本地安装包更新服务'
  $updateGateway = Get-Content -LiteralPath $updateReadyFile -Raw | ConvertFrom-Json

  @(
    'provider: generic',
    "url: $($updateGateway.url)",
    "updaterCacheDirName: $cacheName",
    ''
  ) | Set-Content -LiteralPath (Join-Path $installDir 'resources\app-update.yml') -Encoding utf8NoBOM

  Invoke-UpdateAttempt -Expectation 'failed' -AuthGateway $authGateway -UpdateGateway $updateGateway
  New-Item -ItemType File -Force $allowSignalFile | Out-Null
  Invoke-UpdateAttempt -Expectation 'recovered' -AuthGateway $authGateway -UpdateGateway $updateGateway

  Write-Host (@{
    accepted = $true
    package = (Split-Path $installerPath -Leaf)
    failedBeforeRestart = $true
    recoveredAfterRestart = $true
    updateVersion = $updateGateway.version
  } | ConvertTo-Json -Compress)
} catch {
  $mainError = $_
} finally {
  if ($appProcess) {
    try { Stop-ProcessTree -Process $appProcess -Name 'BilliardBuddy' } catch { if ($null -eq $cleanupError) { $cleanupError = $_ } }
  }
  if ($updateGatewayProcess) {
    try { Stop-ProcessTree -Process $updateGatewayProcess -Name '本地安装包更新服务' } catch { if ($null -eq $cleanupError) { $cleanupError = $_ } }
  }
  if ($authGatewayProcess) {
    try { Stop-ProcessTree -Process $authGatewayProcess -Name '本地安装包激活服务' } catch { if ($null -eq $cleanupError) { $cleanupError = $_ } }
  }
  if ($installed) {
    try {
      $uninstallers = @(Get-ChildItem -LiteralPath $installDir -Filter 'Uninstall*.exe' -File -ErrorAction SilentlyContinue)
      if ($uninstallers.Count -ne 1) { throw 'Windows 更新恢复安装目录没有唯一卸载程序' }
      $uninstaller = Start-Process -FilePath $uninstallers[0].FullName -ArgumentList '/S' -PassThru -Wait
      if ($uninstaller.ExitCode -ne 0) { throw "Windows 卸载程序退出码为 $($uninstaller.ExitCode)" }
      $deadline = (Get-Date).AddSeconds(30)
      while ((Get-Date) -lt $deadline -and (Test-Path -LiteralPath $appPath -PathType Leaf)) { Start-Sleep -Milliseconds 250 }
      if (Test-Path -LiteralPath $appPath -PathType Leaf) { throw 'Windows 更新恢复验收卸载后主程序仍然存在' }
    } catch {
      if ($null -eq $cleanupError) { $cleanupError = $_ }
    }
  }
  if ($cacheDir) { Remove-Item -LiteralPath $cacheDir -Recurse -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  foreach ($name in $environmentNames) {
    [Environment]::SetEnvironmentVariable($name, $previousEnv[$name], 'Process')
  }
}

if ($null -ne $mainError) { throw $mainError }
if ($null -ne $cleanupError) { throw $cleanupError }
