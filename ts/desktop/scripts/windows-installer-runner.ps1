function Invoke-BilliardBuddyWindowsInstaller {
  param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath,
    [Parameter(Mandatory = $true)]
    [string]$InstallDir,
    [Parameter(Mandatory = $true)]
    [string]$TempRoot,
    [Parameter(Mandatory = $true)]
    [string]$FailureLabel,
    [string[]]$AdditionalArguments = @()
  )

  $nsisTemp = Join-Path $TempRoot "nsis-$([Guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Force $nsisTemp | Out-Null
  $previousTemp = [Environment]::GetEnvironmentVariable('TEMP', 'Process')
  $previousTmp = [Environment]::GetEnvironmentVariable('TMP', 'Process')
  $startedAt = Get-Date
  try {
    [Environment]::SetEnvironmentVariable('TEMP', $nsisTemp, 'Process')
    [Environment]::SetEnvironmentVariable('TMP', $nsisTemp, 'Process')
    # NSIS requires /D to be the final argument. Compatibility switches must
    # therefore be inserted before it.
    $arguments = @('/S') + $AdditionalArguments + @("/D=$InstallDir")
    $process = Start-Process -FilePath $InstallerPath -ArgumentList $arguments -PassThru -Wait
  } finally {
    [Environment]::SetEnvironmentVariable('TEMP', $previousTemp, 'Process')
    [Environment]::SetEnvironmentVariable('TMP', $previousTmp, 'Process')
  }

  if ($process.ExitCode -eq 0) { return $process }

  Start-Sleep -Seconds 2
  Write-Host (@{
    installer = $InstallerPath
    exitCode = $process.ExitCode
    nsisTemp = $nsisTemp
    startedAt = $startedAt.ToUniversalTime().ToString('o')
  } | ConvertTo-Json -Compress)

  $installerName = Split-Path $InstallerPath -Leaf
  $applicationEvents = @(Get-WinEvent -FilterHashtable @{
    LogName = 'Application'
    StartTime = $startedAt.AddSeconds(-2)
  } -ErrorAction SilentlyContinue | Where-Object {
    $_.ProviderName -in @('Application Error', 'Windows Error Reporting') -and
      ($_.Message -match [Regex]::Escape($installerName) -or $_.Message -match '0xc0000005')
  } | Select-Object -First 10)
  foreach ($event in $applicationEvents) {
    Write-Host (@{
      eventLog = 'Application'
      time = $event.TimeCreated.ToUniversalTime().ToString('o')
      provider = $event.ProviderName
      id = $event.Id
      message = $event.Message
    } | ConvertTo-Json -Compress)
  }

  $defenderEvents = @(Get-WinEvent -FilterHashtable @{
    LogName = 'Microsoft-Windows-Windows Defender/Operational'
    StartTime = $startedAt.AddSeconds(-2)
  } -ErrorAction SilentlyContinue | Where-Object {
    $_.Message -match [Regex]::Escape($installerName) -or $_.Message -match 'BilliardBuddy'
  } | Select-Object -First 10)
  foreach ($event in $defenderEvents) {
    Write-Host (@{
      eventLog = 'Windows Defender/Operational'
      time = $event.TimeCreated.ToUniversalTime().ToString('o')
      provider = $event.ProviderName
      id = $event.Id
      message = $event.Message
    } | ConvertTo-Json -Compress)
  }

  throw "$FailureLabel 退出码为 $($process.ExitCode)"
}
