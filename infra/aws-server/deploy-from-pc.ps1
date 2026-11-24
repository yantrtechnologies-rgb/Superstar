# Packages the current code (no secrets, no build output), uploads it, and rebuilds/restarts it on the AWS server.
# Usage: powershell -ExecutionPolicy Bypass -File infra\aws-server\deploy-from-pc.ps1
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$out = Join-Path $env:TEMP 'superstar-release.tgz'
if (Test-Path $out) { Remove-Item $out }
Push-Location $Root
try {
  # Windows' own tar (Git's GNU tar misreads "C:" as a remote host).
  & "$env:SystemRoot\System32\tar.exe" -czf $out --exclude=node_modules --exclude=.next --exclude=dist --exclude='.env*' --exclude='.local*' --exclude='*.log' `
    --exclude=.git --exclude=.vercel --exclude=test-results --exclude=playwright-report --exclude=coverage --exclude='*.bak*' --exclude=.turbo .
} finally { Pop-Location }
Write-Host ("package: {0:N1} MB" -f ((Get-Item $out).Length / 1MB))
aws s3 cp $out s3://superstar-media-569659729378/deploy/superstar-release.tgz --region ap-southeast-2 --profile superstar --only-show-errors
if ($LASTEXITCODE -ne 0) { throw 'upload failed' }
$script = Get-Content (Join-Path $PSScriptRoot 'deploy.sh') -Raw
& (Join-Path $PSScriptRoot 'run-remote.ps1') -Script $script -TimeoutSeconds 3000 | Select-Object -Last 12
