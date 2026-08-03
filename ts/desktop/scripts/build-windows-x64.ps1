[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$BuilderArgs
)

# Environment:
#   SKIP_INSTALL=1        Skip root/desktop dependency installation.
#   REBUILD_NATIVE=1      Rebuild Electron native dependencies before packaging.
#   BB_MEDIA_TOOLCHAIN_SOURCE_DIR  Audited LGPL FFmpeg toolchain input directory.

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$desktopDir = (Resolve-Path (Join-Path $scriptDir '..')).Path
$repoRoot = (Resolve-Path (Join-Path $desktopDir '..')).Path

$targetTriple = 'x86_64-pc-windows-msvc'
$canonicalOutputDir = Join-Path $desktopDir 'build-artifacts\windows-x64'
$electronOutputDir = Join-Path $desktopDir 'build-artifacts\electron'

function Write-Step {
  param([string]$Message)
  Write-Host "[build-windows-x64] $Message"
}

function Assert-WindowsHost {
  if ($env:OS -ne 'Windows_NT') {
    throw '[build-windows-x64] This script must run on Windows.'
  }
}

function Assert-Command {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "[build-windows-x64] Missing required command: $Name"
  }
}

function Import-VsDevEnvironment {
  $vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
  if (-not (Test-Path $vswhere)) {
    throw '[build-windows-x64] Could not find vswhere.exe. Install Visual Studio 2022 Build Tools with the C++ workload.'
  }

  $installationPath = & $vswhere `
    -products * `
    -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
    -property installationPath |
    Select-Object -First 1

  if (-not $installationPath) {
    throw '[build-windows-x64] Missing Visual C++ build tools. Install the Desktop development with C++ workload first.'
  }

  $vsDevCmd = Join-Path $installationPath 'Common7\Tools\VsDevCmd.bat'
  if (-not (Test-Path $vsDevCmd)) {
    throw "[build-windows-x64] Could not find VsDevCmd.bat under $installationPath"
  }

  Write-Step "Importing MSVC environment from $vsDevCmd"
  $env:VSCMD_SKIP_SENDTELEMETRY = '1'
  $envDump = & cmd.exe /d /s /c "`"$vsDevCmd`" -arch=x64 -host_arch=x64 >nul && set"
  if ($LASTEXITCODE -ne 0) {
    throw "[build-windows-x64] Failed to initialize Visual Studio build environment (exit $LASTEXITCODE)"
  }

  foreach ($line in $envDump) {
    if ($line -match '^(.*?)=(.*)$') {
      [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
    }
  }
}

function Clear-Directory {
  param([string]$Path)
  if (Test-Path $Path) {
    Remove-Item -LiteralPath $Path -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $Path | Out-Null
}

Assert-WindowsHost
Assert-Command bun
Assert-Command bunx
Import-VsDevEnvironment

if ($env:SKIP_INSTALL -ne '1') {
  Write-Step 'Installing root dependencies...'
  Push-Location $repoRoot
  try {
    & bun install
    if ($LASTEXITCODE -ne 0) {
      throw "[build-windows-x64] bun install failed in repo root (exit $LASTEXITCODE)"
    }
  } finally {
    Pop-Location
  }

  Write-Step 'Installing desktop dependencies...'
  Push-Location $desktopDir
  try {
    & bun install
    if ($LASTEXITCODE -ne 0) {
      throw "[build-windows-x64] bun install failed in desktop (exit $LASTEXITCODE)"
    }
  } finally {
    Pop-Location
  }
}

Write-Step 'Staging audited media toolchain...'
Push-Location $desktopDir
try {
  $env:BB_MEDIA_TOOLCHAIN_PLATFORM = 'win32'
  & bun run stage:media-toolchain
  if ($LASTEXITCODE -ne 0) {
    throw "[build-windows-x64] stage:media-toolchain failed (exit $LASTEXITCODE)"
  }
} finally {
  Pop-Location
}

Write-Step 'Building and staging managed Codex engine...'
Push-Location $desktopDir
try {
  $env:CODEX_ENGINE_TARGET = $targetTriple
  & bun run stage:codex-engine
  if ($LASTEXITCODE -ne 0) {
    throw "[build-windows-x64] stage:codex-engine failed (exit $LASTEXITCODE)"
  }
} finally {
  Pop-Location
}

Write-Step 'Building and staging local Agent plugins...'
Push-Location $desktopDir
try {
  $pluginStages = @(
    'stage:agent-plugins',
    'stage:chrome-plugin',
    'stage:browser-plugin',
    'stage:record-replay-plugin'
  )
  foreach ($pluginStage in $pluginStages) {
    & bun run $pluginStage -- --target $targetTriple
    if ($LASTEXITCODE -ne 0) {
      throw "[build-windows-x64] $pluginStage failed (exit $LASTEXITCODE)"
    }
  }
} finally {
  Pop-Location
}

Write-Step 'Cleaning stale Electron outputs...'
Remove-Item -LiteralPath (Join-Path $desktopDir 'dist') -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $desktopDir 'electron-dist') -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $electronOutputDir -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path (Join-Path $desktopDir 'runtime-assets\binaries\billiardbuddy-sidecar-*') -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $desktopDir 'tsconfig.tsbuildinfo') -Force -ErrorAction SilentlyContinue

Write-Step "Building sidecars for $targetTriple..."
Push-Location $desktopDir
try {
  $env:SIDECAR_TARGET_TRIPLE = $targetTriple
  & bun run build:sidecars
  if ($LASTEXITCODE -ne 0) {
    throw "[build-windows-x64] build:sidecars failed (exit $LASTEXITCODE)"
  }

  Write-Step 'Building renderer and Electron main/preload bundles...'
  & bun run build
  if ($LASTEXITCODE -ne 0) {
    throw "[build-windows-x64] renderer build failed (exit $LASTEXITCODE)"
  }
  & bun run build:electron
  if ($LASTEXITCODE -ne 0) {
    throw "[build-windows-x64] Electron build failed (exit $LASTEXITCODE)"
  }

  if ($env:REBUILD_NATIVE -eq '1') {
    Write-Step 'Rebuilding native dependencies for Electron ABI...'
    & bunx electron-builder install-app-deps
    if ($LASTEXITCODE -ne 0) {
      throw "[build-windows-x64] electron-builder install-app-deps failed (exit $LASTEXITCODE)"
    }
  }

  $args = @('electron-builder', '--win', 'nsis', '--x64', '--publish', 'never')
  $remainingArgs = @($BuilderArgs)
  if ($remainingArgs.Count -gt 0) {
    $args += $remainingArgs
  }

  Write-Step 'Packaging Electron app...'
  & bunx @args
  if ($LASTEXITCODE -ne 0) {
    throw "[build-windows-x64] electron-builder failed (exit $LASTEXITCODE)"
  }
} finally {
  Pop-Location
}

Clear-Directory -Path $canonicalOutputDir

Get-ChildItem -Path $electronOutputDir -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '\.(exe|blockmap|yml)$' } |
  ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $canonicalOutputDir $_.Name) -Force }

$winUnpackedDir = Join-Path $electronOutputDir 'win-unpacked'
if (Test-Path $winUnpackedDir) {
  Copy-Item -LiteralPath $winUnpackedDir -Destination (Join-Path $canonicalOutputDir 'win-unpacked') -Recurse -Force
}

Set-Content -Path (Join-Path $canonicalOutputDir 'BUILD_INFO.txt') -Value @"
Target triple: $targetTriple
Builder output: $electronOutputDir
Canonical output: $canonicalOutputDir
Built at: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')
"@ -Encoding UTF8

Write-Step 'Build finished.'
Write-Step "Canonical output: $canonicalOutputDir"
