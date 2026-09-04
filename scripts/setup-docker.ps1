param(
  [switch]$SkipStart
)

$ErrorActionPreference = 'Stop'

$releaseBase = if ($env:KINESYNC_DOCKER_RELEASE_BASE_URL) {
  $env:KINESYNC_DOCKER_RELEASE_BASE_URL.TrimEnd('/')
} else {
  'https://github.com/Kineticron/KineSync/releases/download/desktop-latest'
}

# $PSScriptRoot is empty when this script is piped through `irm … | iex`.
# In that case, keep the installation in the caller's current directory.
$isRemoteBootstrap = [string]::IsNullOrWhiteSpace($PSScriptRoot)
$repoRoot = if ($env:KINESYNC_ROOT) {
  $env:KINESYNC_ROOT
} elseif ($PSScriptRoot) {
  if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'compose.yaml')) {
    $PSScriptRoot
  } else {
    Split-Path -Parent $PSScriptRoot
  }
} else {
  (Get-Location).Path
}
New-Item -ItemType Directory -Force -Path $repoRoot | Out-Null
$envPath = Join-Path $repoRoot '.env'
$composePath = Join-Path $repoRoot 'compose.yaml'

if ($isRemoteBootstrap -or -not (Test-Path -LiteralPath $composePath)) {
  Write-Host 'Downloading the KineSync Docker Compose definition…'
  $tempComposePath = "$composePath.tmp.$PID"
  try {
    Invoke-WebRequest -Uri "$releaseBase/compose.yaml" -OutFile $tempComposePath -UseBasicParsing
    Move-Item -LiteralPath $tempComposePath -Destination $composePath -Force
  } finally {
    Remove-Item -LiteralPath $tempComposePath -Force -ErrorAction SilentlyContinue
  }
}

if (Test-Path -LiteralPath $envPath) {
  Write-Host '.env already exists; leaving it unchanged.'
} else {
  $bridgeKey = [Convert]::ToHexString(
    [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
  ).ToLowerInvariant()
$contents = @"
KINESYNC_IMAGE=ghcr.io/kineticron/kinesync-desktop-bridge:latest
KINESYNC_PULL_POLICY=always
KINESYNC_CONTAINER_NAME=kinesync
BRIDGE_KEY=$bridgeKey
KINESYNC_WEB_USER=kinesync
KINESYNC_WEB_PASSWORD=
KINESYNC_CONFIG_PATH=./.kinesync-config
KINESYNC_WEB_PORT=3000
KINESYNC_WEB_HTTPS_PORT=3443
KINESYNC_WEB_BIND_ADDRESS=127.0.0.1
KINESYNC_BRIDGE_BIND_ADDRESS=0.0.0.0
PUID=568
PGID=568
TZ=America/New_York
"@
$tempEnvPath = "$envPath.tmp.$PID"
[IO.File]::WriteAllText($tempEnvPath, $contents, [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $tempEnvPath -Destination $envPath -Force
Write-Host 'Created local configuration. The localhost-only app view needs no password.'
}

if ($SkipStart -or $env:KINESYNC_SKIP_START -eq '1') {
  Write-Host "Configuration ready in $envPath. Start with: docker compose -f `"$composePath`" up -d"
  exit 0
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw 'Docker was not found. Install Docker Desktop, then run this script again.'
}
docker compose version | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw 'Docker Compose v2 is required. Update Docker Desktop and run this script again.'
}

Write-Host 'Downloading the latest KineSync Desktop Bridge image…'
docker compose --project-directory $repoRoot pull kinesync
if ($LASTEXITCODE -ne 0) { throw 'Unable to download the KineSync image from GHCR.' }
Write-Host 'Starting KineSync…'
docker compose --project-directory $repoRoot up -d kinesync
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose could not start KineSync.' }
docker compose --project-directory $repoRoot ps kinesync
Write-Host 'Done. Open KineSync at http://localhost:3000; pair ExpoLyrics with ws://<this-host-LAN-IP>:3001.'
try {
  Start-Process 'http://localhost:3000'
} catch {
  Write-Host 'Open http://localhost:3000 in a browser to finish setup.'
}
