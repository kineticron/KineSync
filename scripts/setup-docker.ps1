param(
  [switch]$SkipStart,
  [switch]$SkipUi,
  [switch]$BuildLocal
)

$ErrorActionPreference = 'Stop'

$xpraVersion = '6.5.3-r0'
$xpraArchiveName = "Xpra-Light-x86_64_$xpraVersion.zip"
$xpraArchiveSha256 = '93B7CFFC5EAE91F3FAE22AAEE14C53C3AC9F06A33E026B2CAB056EC8A1E79366'
$xpraDownloadUrl = "https://xpra.org/dists/windows/$xpraArchiveName"

function Invoke-KineSyncDownload {
  param(
    [Parameter(Mandatory = $true)][uri]$Uri,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
    try {
      & curl.exe --fail --location --connect-timeout 5 --retry 1 --retry-all-errors `
        --output $Destination $Uri.AbsoluteUri
      if ($LASTEXITCODE -eq 0) { return }
    } catch {
      # Retry below without inherited proxy settings.
    }

    Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
    Write-Host 'The configured proxy could not reach the download; retrying directly…'
    try {
      # --ssl-no-revoke keeps certificate validation enabled, but avoids a
      # Windows Schannel failure when the CRL endpoint itself is unreachable.
      & curl.exe --noproxy '*' --ssl-no-revoke --fail --location --retry 3 `
        --output $Destination $Uri.AbsoluteUri
      if ($LASTEXITCODE -eq 0) { return }
    } catch {
      # Invoke-WebRequest is the final compatibility fallback.
    }
  }

  Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
  try {
    $requestArguments = @{
      UseBasicParsing = $true
      Uri = $Uri.AbsoluteUri
      OutFile = $Destination
    }
    if ((Get-Command Invoke-WebRequest).Parameters.ContainsKey('NoProxy')) {
      $requestArguments['NoProxy'] = $true
    }
    Invoke-WebRequest @requestArguments
  } catch {
    Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
    throw "Unable to download $($Uri.AbsoluteUri). Check firewall or proxy settings and try again. $($_.Exception.Message)"
  }
}

function New-KineSyncRandomHex {
  param([Parameter(Mandatory = $true)][ValidateRange(1, 1024)][int]$ByteCount)

  $bytes = New-Object byte[] $ByteCount
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
  return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Test-KineSyncTcpPort {
  param([Parameter(Mandatory = $true)][ValidateRange(1, 65535)][int]$Port)

  $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $Port)
  try { $listener.Start(); return $true } catch { return $false } finally { $listener.Stop() }
}

function Find-KineSyncTcpPort {
  param(
    [Parameter(Mandatory = $true)][ValidateRange(1, 65535)][int]$PreferredPort,
    [Parameter(Mandatory = $true)][ValidateRange(1, 65535)][int]$FallbackStart
  )

  if (Test-KineSyncTcpPort -Port $PreferredPort) { return $PreferredPort }
  foreach ($candidate in $FallbackStart..($FallbackStart + 89)) {
    if (Test-KineSyncTcpPort -Port $candidate) { return $candidate }
  }
  throw "No available localhost port was found near $PreferredPort."
}

function Wait-KineSyncWindowService {
  param(
    [string]$ContainerName = 'kinesync',
    [ValidateRange(1, 300)][int]$TimeoutSeconds = 90
  )

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      docker exec $ContainerName xpra id --compressors=brotli tcp://127.0.0.1:14500/ `
        2>$null | Out-Null
      if ($LASTEXITCODE -eq 0) { return }
    } catch {
      # The container is still starting. Retry until the deadline.
    }
    Start-Sleep -Milliseconds 500
  }
  throw "KineSync started, but its native-window service did not complete its startup handshake. Run 'docker logs $ContainerName' for details."
}

function Get-KineSyncEnvValue {
  param(
    [Parameter(Mandatory = $true)][string]$Contents,
    [Parameter(Mandatory = $true)][string]$Name,
    [string]$Default = ''
  )

  $match = [regex]::Match($Contents, "(?m)^$([regex]::Escape($Name))=(.*)$")
  if ($match.Success) { return $match.Groups[1].Value.Trim() }
  return $Default
}

function Set-KineSyncEnvValue {
  param(
    [Parameter(Mandatory = $true)][string]$Contents,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Value
  )

  $pattern = "(?m)^$([regex]::Escape($Name))=.*$"
  if ([regex]::IsMatch($Contents, $pattern)) {
    $matcher = New-Object Text.RegularExpressions.Regex($pattern)
    return $matcher.Replace($Contents, "$Name=$Value", 1)
  }
  return $Contents.TrimEnd() + [Environment]::NewLine + "$Name=$Value" + [Environment]::NewLine
}

function Get-KineSyncXpra {
  param([Parameter(Mandatory = $true)][string]$InstallRoot)

  $clientRoot = Join-Path $InstallRoot 'xpra-client'
  $clientPath = Join-Path $clientRoot "Xpra-Light-x86_64_$xpraVersion\Xpra.exe"
  if (Test-Path -LiteralPath $clientPath) { return $clientPath }

  New-Item -ItemType Directory -Force -Path $clientRoot | Out-Null
  $archivePath = Join-Path $clientRoot $xpraArchiveName
  Write-Host 'Downloading the portable native-window client…'
  Invoke-KineSyncDownload -Uri $xpraDownloadUrl -Destination $archivePath
  $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash
  if ($actualHash -ne $xpraArchiveSha256) {
    Remove-Item -LiteralPath $archivePath -Force
    throw 'The downloaded Xpra client did not match its expected SHA-256 checksum.'
  }
  Expand-Archive -LiteralPath $archivePath -DestinationPath $clientRoot -Force
  Remove-Item -LiteralPath $archivePath -Force
  if (-not (Test-Path -LiteralPath $clientPath)) { throw 'The Xpra client archive had an unexpected layout.' }
  return $clientPath
}

$releaseBase = if ($env:KINESYNC_DOCKER_RELEASE_BASE_URL) {
  $env:KINESYNC_DOCKER_RELEASE_BASE_URL.TrimEnd('/')
} else {
  'https://github.com/Kineticron/KineSync/releases/latest/download'
}

# A piped one-line install uses a stable per-user folder and needs no clone.
$isRemoteBootstrap = [string]::IsNullOrWhiteSpace($PSScriptRoot)
$repoRoot = if ($env:KINESYNC_ROOT) {
  $env:KINESYNC_ROOT
} elseif ($PSScriptRoot) {
  if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'compose.yaml')) { $PSScriptRoot }
  else { Split-Path -Parent $PSScriptRoot }
} elseif ((Test-Path -LiteralPath (Join-Path (Get-Location).Path 'compose.yaml')) -and
          (Test-Path -LiteralPath (Join-Path (Get-Location).Path '.env'))) {
  # Reuse installs created by older versions of the one-line command.
  (Get-Location).Path
} else {
  Join-Path $env:LOCALAPPDATA 'KineSync\Docker'
}
New-Item -ItemType Directory -Force -Path $repoRoot | Out-Null
$envPath = Join-Path $repoRoot '.env'
$composePath = Join-Path $repoRoot 'compose.yaml'
$devComposePath = Join-Path $repoRoot 'compose.dev.yaml'

if ($BuildLocal -and -not (Test-Path -LiteralPath $devComposePath)) {
  throw '-BuildLocal must be run from a KineSync source checkout containing compose.dev.yaml.'
}

if ($isRemoteBootstrap -or -not (Test-Path -LiteralPath $composePath)) {
  Write-Host 'Downloading the KineSync Docker Compose definition…'
  $tempComposePath = "$composePath.tmp.$PID"
  try {
    Invoke-KineSyncDownload -Uri "$releaseBase/compose.yaml" -Destination $tempComposePath
    Move-Item -LiteralPath $tempComposePath -Destination $composePath -Force
  } finally {
    Remove-Item -LiteralPath $tempComposePath -Force -ErrorAction SilentlyContinue
  }
}

if (Test-Path -LiteralPath $envPath) {
  Write-Host '.env already exists; preserving its settings and applying any migration.'
  $envContents = [IO.File]::ReadAllText($envPath)
  if (-not [regex]::IsMatch($envContents, '(?m)^KINESYNC_UI_PORT=')) {
    $envContents = Set-KineSyncEnvValue -Contents $envContents -Name 'KINESYNC_UI_PORT' -Value '14500'
  }
  if (-not [regex]::IsMatch($envContents, '(?m)^KINESYNC_UI_BIND_ADDRESS=')) {
    $envContents = Set-KineSyncEnvValue -Contents $envContents -Name 'KINESYNC_UI_BIND_ADDRESS' -Value '127.0.0.1'
  }
} else {
  $bridgeKey = New-KineSyncRandomHex -ByteCount 32
  $uiPort = Find-KineSyncTcpPort -PreferredPort 14500 -FallbackStart 14501
  $envContents = @"
KINESYNC_IMAGE=ghcr.io/kineticron/kinesync-desktop-bridge:latest
KINESYNC_PULL_POLICY=always
KINESYNC_CONTAINER_NAME=kinesync
BRIDGE_KEY=$bridgeKey
KINESYNC_CONFIG_PATH=./.kinesync-config
KINESYNC_UI_PORT=$uiPort
KINESYNC_UI_BIND_ADDRESS=127.0.0.1
KINESYNC_BRIDGE_BIND_ADDRESS=0.0.0.0
PUID=568
PGID=568
TZ=America/New_York
"@
  Write-Host 'Created local configuration. No VNC username or password is required.'
}

$uiPort = [int](Get-KineSyncEnvValue -Contents $envContents -Name 'KINESYNC_UI_PORT' -Default '14500')
$containerName = Get-KineSyncEnvValue -Contents $envContents -Name 'KINESYNC_CONTAINER_NAME' -Default 'kinesync'
$containerRunning = $false
if (Get-Command docker -ErrorAction SilentlyContinue) {
  # Listing containers is quiet when this is a first install. `docker inspect`
  # prints "no such object" for the normal missing-container case.
  $runningContainerNames = @(docker container ls --format '{{.Names}}' 2>$null)
  if ($LASTEXITCODE -eq 0) {
    $containerRunning = $runningContainerNames -contains $containerName
  }
}
if (-not $containerRunning -and -not (Test-KineSyncTcpPort -Port $uiPort)) {
  $oldPort = $uiPort
  $uiPort = Find-KineSyncTcpPort -PreferredPort $uiPort -FallbackStart 14501
  $envContents = Set-KineSyncEnvValue -Contents $envContents -Name 'KINESYNC_UI_PORT' -Value $uiPort
  Write-Host "Port $oldPort is unavailable; using $uiPort for the native-window connection."
}
$tempEnvPath = "$envPath.tmp.$PID"
[IO.File]::WriteAllText($tempEnvPath, $envContents, [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $tempEnvPath -Destination $envPath -Force

if ($SkipStart -or $env:KINESYNC_SKIP_START -eq '1') {
  Write-Host "Configuration ready in $envPath. Start with: docker compose --project-directory `"$repoRoot`" up -d"
  exit 0
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw 'Docker was not found. Install Docker Desktop, then run this command again.'
}
docker compose version | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose v2 is required. Update Docker Desktop and run this command again.' }

# Acquire the host window client before changing the running container. A
# download failure must not turn a working installation into a headless one.
$xpraPath = $null
if (-not $SkipUi -and $env:KINESYNC_SKIP_UI -ne '1') {
  $xpraPath = Get-KineSyncXpra -InstallRoot $repoRoot
}

if ($BuildLocal) {
  Write-Host 'Building and starting KineSync from this source checkout…'
  docker compose --project-directory $repoRoot -f $composePath -f $devComposePath up -d --build kinesync
} else {
  Write-Host 'Downloading the latest KineSync Desktop Bridge image…'
  docker compose --project-directory $repoRoot pull kinesync
  if ($LASTEXITCODE -ne 0) { throw 'Unable to download the KineSync image from GHCR.' }
  Write-Host 'Starting KineSync…'
  docker compose --project-directory $repoRoot up -d kinesync
}
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose could not start KineSync.' }
docker compose --project-directory $repoRoot ps kinesync

if (-not $SkipUi -and $env:KINESYNC_SKIP_UI -ne '1') {
  Write-Host 'Waiting for the KineSync window service…'
  Wait-KineSyncWindowService -ContainerName $containerName
  Write-Host 'Opening the KineSync windows…'
  Start-Process -FilePath $xpraPath -ArgumentList @(
    'attach', "tcp://127.0.0.1:$uiPort/", '--reconnect=yes',
    '--compressors=brotli', '--speaker=off', '--microphone=off',
    '--webcam=no', '--printing=no'
  )
}

Write-Host 'Done. KineSync now appears as normal desktop windows; pair ExpoLyrics with ws://<this-host-LAN-IP>:3001.'
