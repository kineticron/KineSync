$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $repoRoot '.env'
if (Test-Path -LiteralPath $envPath) {
  Write-Host '.env already exists; leaving it unchanged.'
  exit 0
}

$bridgeKey = [Convert]::ToHexString(
  [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
).ToLowerInvariant()
$webPassword = [Convert]::ToHexString(
  [Security.Cryptography.RandomNumberGenerator]::GetBytes(24)
).ToLowerInvariant()

$contents = @"
BRIDGE_KEY=$bridgeKey
KINESYNC_WEB_USER=kinesync
KINESYNC_WEB_PASSWORD=$webPassword
KINESYNC_CONFIG_PATH=./.kinesync-config
KINESYNC_WEB_BIND_ADDRESS=127.0.0.1
KINESYNC_BRIDGE_BIND_ADDRESS=0.0.0.0
PUID=568
PGID=568
TZ=America/New_York
"@
[IO.File]::WriteAllText($envPath, $contents, [Text.UTF8Encoding]::new($false))
Write-Host 'Created .env with unique random bridge and web passwords.'
Write-Host 'Run: docker compose up -d --build'
