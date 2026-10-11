# Runs locally; source files are never uploaded to a scanning service.
$ErrorActionPreference = 'Stop'
$taskRepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $taskRepoRoot
try {
  $output = & npm.cmd exec --yes --package=oxlint@1.87.0 -- oxlint `
    -A all -D perf --react-plugin --react-perf-plugin --promise-plugin --node-plugin `
    --ignore-pattern '**/*bundle*' --ignore-pattern '**/vendor/**' -f json `
    ExpoLyrics/app ExpoLyrics/components ExpoLyrics/hooks ExpoLyrics/lib `
    ExpoLyrics/providers ExpoLyrics/store DesktopBridge/src
  $scanExitCode = $LASTEXITCODE
  $json = $output -join [Environment]::NewLine
  $report = $json | ConvertFrom-Json
  $cachePath = Join-Path $taskRepoRoot '.cache'
  New-Item -ItemType Directory -Path $cachePath -Force | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $cachePath 'optimization-scan.json'), $json)
  Write-Output "Scanned $($report.number_of_files) source files with Oxlint 1.87.0."
  $report.diagnostics | Group-Object code | Select-Object Count, Name | Format-Table
  Write-Output 'Full findings: .cache/optimization-scan.json'
  exit $scanExitCode
} finally {
  Pop-Location
}
