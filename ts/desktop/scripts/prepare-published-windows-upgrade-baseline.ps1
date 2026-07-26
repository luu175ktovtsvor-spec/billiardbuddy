$ErrorActionPreference = 'Stop'
$baselineVersion = '0.4.9'
$baselineName = 'BilliardBuddy-0.4.9-win-x64.exe'
$baselineUrl = 'https://zzyppz.cn/desktop/BilliardBuddy-0.4.9-win-x64.exe'
$expectedSize = 239427245
$expectedSha512 = 'XJViXgG33Ps+pyjMT4xbLqDrhN9mTEdIqA3qNJ3JKqgqbxk2k23OjxLGUxC/bsK3GVDrwTbxZ17KuF3nazCIHw=='
$tempBase = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$baselineDir = Join-Path $tempBase 'billiardbuddy-published-0.4.9-installer'
$installerPath = Join-Path $baselineDir $baselineName

if (Test-Path -LiteralPath $baselineDir) {
  throw 'Windows 正式升级基线目录已存在'
}
New-Item -ItemType Directory -Force $baselineDir | Out-Null

Invoke-WebRequest -Uri $baselineUrl -OutFile $installerPath -MaximumRetryCount 2 -RetryIntervalSec 2
$installer = Get-Item -LiteralPath $installerPath
if ($installer.Length -ne $expectedSize) {
  throw "Windows 正式升级基线大小不正确: expected=$expectedSize actual=$($installer.Length)"
}

$stream = [IO.File]::OpenRead($installerPath)
$sha512 = [Security.Cryptography.SHA512]::Create()
try {
  $actualSha512 = [Convert]::ToBase64String($sha512.ComputeHash($stream))
} finally {
  $sha512.Dispose()
  $stream.Dispose()
}
if ($actualSha512 -ne $expectedSha512) {
  throw "Windows 正式升级基线 SHA-512 不正确: expected=$expectedSha512 actual=$actualSha512"
}

$actualVersion = $installer.VersionInfo.ProductVersion
if ([string]::IsNullOrWhiteSpace($actualVersion) -or -not $actualVersion.StartsWith($baselineVersion)) {
  throw "Windows 正式升级基线版本不正确: expected=$baselineVersion actual=$actualVersion"
}
if (-not $env:GITHUB_ENV) {
  throw '缺少 GITHUB_ENV，无法传递 Windows 正式升级基线'
}
"BB_OLD_WINDOWS_INSTALLER=$installerPath" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
Write-Host (@{
  version = $baselineVersion
  installer = $installerPath
  size = $installer.Length
  sha512 = $actualSha512
  source = $baselineUrl
} | ConvertTo-Json -Compress)
