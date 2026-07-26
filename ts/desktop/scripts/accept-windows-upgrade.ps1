param(
  [Parameter(Mandatory = $true)]
  [string]$OldInstaller,
  [Parameter(Mandatory = $true)]
  [string]$NewInstaller
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-installer-runner.ps1')
$oldInstallerPath = (Resolve-Path -LiteralPath $OldInstaller).Path
$newInstallerPath = (Resolve-Path -LiteralPath $NewInstaller).Path
$desktopDir = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$tempBase = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$tempRoot = Join-Path $tempBase "billiardbuddy-upgrade-acceptance-$([Guid]::NewGuid().ToString('N'))"
$installDir = Join-Path $tempRoot 'installed'
$configDir = Join-Path $tempRoot 'config'
$userDataDir = Join-Path $tempRoot 'user-data'
$oldWorkspace = Join-Path $tempRoot 'old-workspace'
$appPath = Join-Path $installDir 'BilliardBuddy.exe'
$evidenceFile = Join-Path $tempRoot 'upgrade-evidence.json'
$authReadyFile = Join-Path $tempRoot 'auth-gateway.json'
$probeScript = Join-Path $PSScriptRoot 'package-renderer-product-api.ts'
$storageScript = Join-Path $PSScriptRoot 'package-upgrade-storage.ts'
$appProcess = $null
$authGatewayProcess = $null
$installed = $false
$mainError = $null
$cleanupError = $null
$environmentNames = @(
  'BILLIARDBUDDY_CONFIG_DIR',
  'CLAUDE_CONFIG_DIR',
  'BB_ELECTRON_DISABLE_SINGLE_INSTANCE_LOCK',
  'BB_ELECTRON_WINDOW_SMOKE_LOG',
  'QF_GATEWAY_URL',
  'QF_GATEWAY_TOKEN',
  'QF_GATEWAY_MODEL',
  'BB_GATEWAY_URL',
  'BB_GATEWAY_BOOTSTRAP_CREDENTIAL',
  'BB_LICENSE_KEY',
  'NODE_EXTRA_CA_CERTS'
)
$previousEnv = @{}
foreach ($name in $environmentNames) {
  $previousEnv[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

function Set-LaunchEnvironment {
  param(
    [Parameter(Mandatory = $true)]
    [hashtable]$Values
  )
  foreach ($name in $environmentNames) {
    $value = if ($Values.ContainsKey($name)) { $Values[$name] } else { $null }
    [Environment]::SetEnvironmentVariable($name, $value, 'Process')
  }
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

function Install-Package {
  param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedVersion
  )
  $process = Invoke-BilliardBuddyWindowsInstaller `
    -InstallerPath $InstallerPath `
    -InstallDir $installDir `
    -TempRoot $tempRoot `
    -FailureLabel "Windows $ExpectedVersion 安装程序"
  if (-not (Test-Path -LiteralPath $appPath -PathType Leaf)) { throw "Windows $ExpectedVersion 安装后缺少 BilliardBuddy.exe" }
  $script:installed = $true
  $actualVersion = (Get-Item -LiteralPath $appPath).VersionInfo.ProductVersion
  if ([string]::IsNullOrWhiteSpace($actualVersion) -or -not $actualVersion.StartsWith($ExpectedVersion)) {
    throw "Windows 安装版本不正确: expected=$ExpectedVersion actual=$actualVersion"
  }
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

function Assert-CurrentReady {
  param(
    [Parameter(Mandatory = $true)]
    [string]$SmokeLog
  )
  if (-not (Test-Path -LiteralPath $SmokeLog -PathType Leaf)) { throw '当前安装包没有写入窗口/后端启动证据' }
  $snapshots = @(Get-Content -LiteralPath $SmokeLog | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
  if ($snapshots | Where-Object { $_.reason -in @('backend-failed', 'backend-initialization-failed') }) {
    throw '当前安装包的 Product Server 启动失败'
  }
  if (-not ($snapshots | Where-Object { $_.reason -eq 'backend-ready' })) {
    throw '当前安装包没有进入 backend-ready'
  }
  $final = @($snapshots | Where-Object { $_.reason -eq 'after-final-show' } | Select-Object -Last 1)
  if ($final.Count -ne 1 -or $final[0].visible -ne $true -or $final[0].destroyed -ne $false) {
    throw '当前安装包没有显示正式产品窗口'
  }
}

function Invoke-RendererProbe {
  param(
    [string]$CreateTaskWorkDir,
    [string]$ExpectedTaskId,
    [bool]$RequireCurrentReady,
    [hashtable]$Environment
  )
  $port = Get-FreePort
  $smokeLog = Join-Path $tempRoot "window-smoke-$([Guid]::NewGuid().ToString('N')).jsonl"
  $launchEnvironment = @{
    BILLIARDBUDDY_CONFIG_DIR = $configDir
    BB_ELECTRON_DISABLE_SINGLE_INSTANCE_LOCK = '1'
    BB_ELECTRON_WINDOW_SMOKE_LOG = $smokeLog
  }
  foreach ($entry in $Environment.GetEnumerator()) { $launchEnvironment[$entry.Key] = $entry.Value }
  Set-LaunchEnvironment -Values $launchEnvironment
  $script:appProcess = Start-Process -FilePath $appPath -ArgumentList @(
    "--user-data-dir=$userDataDir",
    "--remote-debugging-port=$port"
  ) -PassThru
  try {
    $arguments = @('run', $probeScript, '--port', "$port")
    if (-not [string]::IsNullOrWhiteSpace($CreateTaskWorkDir)) {
      $arguments += @('--create-task-work-dir', $CreateTaskWorkDir)
    }
    if (-not [string]::IsNullOrWhiteSpace($ExpectedTaskId)) {
      $arguments += @('--expected-task-id', $ExpectedTaskId)
    }
    $output = @(& bun @arguments)
    if ($LASTEXITCODE -ne 0) { throw '安装包 renderer 产品 API 验收失败' }
    $jsonLine = @($output | Where-Object { $_ -match '^\{' } | Select-Object -Last 1)
    if ($jsonLine.Count -ne 1) { throw '安装包 renderer 验收没有返回唯一 JSON 结果' }
    $result = $jsonLine[0] | ConvertFrom-Json
    if ($RequireCurrentReady) { Assert-CurrentReady -SmokeLog $smokeLog }
    return $result
  } finally {
    if ($script:appProcess) {
      Stop-ProcessTree -Process $script:appProcess -Name 'BilliardBuddy'
      $script:appProcess = $null
    }
  }
}

function Invoke-StorageEvidence {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Operation,
    [Parameter(Mandatory = $true)]
    [string]$TaskId
  )
  & bun run $storageScript $Operation --config-dir $configDir --task-id $TaskId --evidence-file $evidenceFile
  if ($LASTEXITCODE -ne 0) { throw "升级存储验收失败: $Operation" }
}

try {
  New-Item -ItemType Directory -Force $tempRoot, $configDir, $userDataDir, $oldWorkspace | Out-Null

  Install-Package -InstallerPath $oldInstallerPath -ExpectedVersion '0.4.9'
  $oldLaunch = Invoke-RendererProbe -CreateTaskWorkDir $oldWorkspace -ExpectedTaskId '' -RequireCurrentReady $false -Environment @{
    CLAUDE_CONFIG_DIR = $configDir
    QF_GATEWAY_URL = 'https://example.test/gw'
    QF_GATEWAY_TOKEN = 'YOUR_API_KEY_1234'
    QF_GATEWAY_MODEL = 'qwen3.5-plus'
  }
  if ([string]::IsNullOrWhiteSpace($oldLaunch.createdTaskId)) { throw '最老支持安装包没有返回真实任务标识' }
  $taskId = $oldLaunch.createdTaskId
  Invoke-StorageEvidence -Operation 'seed' -TaskId $taskId

  Install-Package -InstallerPath $newInstallerPath -ExpectedVersion '0.5.0'
  $authGatewayProcess = Start-Process -FilePath 'bun' -ArgumentList @(
    'run',
    (Join-Path $PSScriptRoot 'package-auth-gateway.ts'),
    '--ready-file',
    $authReadyFile
  ) -WorkingDirectory $desktopDir -PassThru -NoNewWindow
  $gatewayDeadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $gatewayDeadline -and -not (Test-Path -LiteralPath $authReadyFile -PathType Leaf)) {
    if ($authGatewayProcess.HasExited) { throw "本地安装包激活服务提前退出: $($authGatewayProcess.ExitCode)" }
    Start-Sleep -Milliseconds 100
  }
  if (-not (Test-Path -LiteralPath $authReadyFile -PathType Leaf)) { throw '本地安装包激活服务未在 15 秒内就绪' }
  $gateway = Get-Content -LiteralPath $authReadyFile -Raw | ConvertFrom-Json
  $currentLaunch = Invoke-RendererProbe -CreateTaskWorkDir '' -ExpectedTaskId $taskId -RequireCurrentReady $true -Environment @{
    BB_GATEWAY_URL = $gateway.url
    BB_GATEWAY_BOOTSTRAP_CREDENTIAL = $gateway.bootstrapCredential
    BB_LICENSE_KEY = $gateway.licenseKey
    NODE_EXTRA_CA_CERTS = $gateway.caPath
  }
  Invoke-StorageEvidence -Operation 'verify-upgrade' -TaskId $taskId
  Stop-ProcessTree -Process $authGatewayProcess -Name '本地安装包激活服务'
  $authGatewayProcess = $null

  Install-Package -InstallerPath $oldInstallerPath -ExpectedVersion '0.4.9'
  $rollbackLaunch = Invoke-RendererProbe -CreateTaskWorkDir '' -ExpectedTaskId $taskId -RequireCurrentReady $false -Environment @{
    CLAUDE_CONFIG_DIR = $configDir
    QF_GATEWAY_URL = 'https://example.test/gw'
    QF_GATEWAY_TOKEN = 'YOUR_API_KEY_1234'
    QF_GATEWAY_MODEL = 'qwen3.5-plus'
  }
  Invoke-StorageEvidence -Operation 'verify-rollback' -TaskId $taskId

  Write-Host (@{
    accepted = $true
    oldVersion = '0.4.9'
    newVersion = '0.5.0'
    migratedTaskId = $taskId
    interruptedMigrationRecovered = $true
    rollbackRelaunched = $true
    rendererUrls = @($oldLaunch.url, $currentLaunch.url, $rollbackLaunch.url)
  } | ConvertTo-Json -Compress)
} catch {
  $mainError = $_
} finally {
  if ($appProcess) {
    try { Stop-ProcessTree -Process $appProcess -Name 'BilliardBuddy' } catch { if ($null -eq $cleanupError) { $cleanupError = $_ } }
  }
  if ($authGatewayProcess) {
    try { Stop-ProcessTree -Process $authGatewayProcess -Name '本地安装包激活服务' } catch { if ($null -eq $cleanupError) { $cleanupError = $_ } }
  }
  if ($installed) {
    try {
      $uninstallers = @(Get-ChildItem -LiteralPath $installDir -Filter 'Uninstall*.exe' -File -ErrorAction SilentlyContinue)
      if ($uninstallers.Count -ne 1) { throw 'Windows 回退安装目录没有唯一卸载程序' }
      $uninstaller = Start-Process -FilePath $uninstallers[0].FullName -ArgumentList '/S' -PassThru -Wait
      if ($uninstaller.ExitCode -ne 0) { throw "Windows 回退包卸载程序退出码为 $($uninstaller.ExitCode)" }
      $deadline = (Get-Date).AddSeconds(30)
      while ((Get-Date) -lt $deadline -and (Test-Path -LiteralPath $appPath -PathType Leaf)) { Start-Sleep -Milliseconds 250 }
      if (Test-Path -LiteralPath $appPath -PathType Leaf) { throw 'Windows 回退包卸载后主程序仍然存在' }
    } catch {
      if ($null -eq $cleanupError) { $cleanupError = $_ }
    }
  }
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  foreach ($name in $environmentNames) {
    [Environment]::SetEnvironmentVariable($name, $previousEnv[$name], 'Process')
  }
}

if ($null -ne $mainError) { throw $mainError }
if ($null -ne $cleanupError) { throw $cleanupError }
