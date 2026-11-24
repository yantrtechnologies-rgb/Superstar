# Rebuilds the shared data package and the web app, then restarts the web server on port 3000.
param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$usePnpm = [bool](Get-Command pnpm -ErrorAction SilentlyContinue)
function Invoke-Pnpm([string[]]$a) {
  if ($usePnpm) { & pnpm @a } else { & corepack pnpm @a }
  if ($LASTEXITCODE -ne 0) { throw "pnpm $($a -join ' ') failed with exit code $LASTEXITCODE" }
}
Write-Host '== Stopping web, API and worker so they reload settings'
foreach ($port in 3000, 3001, 3002) {
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
}
Start-Sleep 2
if (-not $SkipBuild) {
  if (Select-String -Path (Join-Path $Root '.env.local-stack') -Pattern '^RDS_INSTANCE_ID=.+' -Quiet -ErrorAction SilentlyContinue) {
    Write-Host '== Starting the AWS database if it was stopped while idle'
    & (Join-Path $PSScriptRoot 'aws-db.ps1') start
  }
  Write-Host '== Database migrations'
  & (Join-Path $PSScriptRoot 'migrate-local-db.ps1')
  Write-Host '== Generating Prisma client'
  Invoke-Pnpm @('db:generate')
  Write-Host '== Building @cadencedesk/data'
  Invoke-Pnpm @('--filter', '@cadencedesk/data', 'build')
  Write-Host '== Building @cadencedesk/web'
  Invoke-Pnpm @('--filter', '@cadencedesk/web', 'build')
}
Start-Sleep 2
Write-Host '== Starting the stack'
# A fixed ngrok domain in .env.local-stack takes precedence over a pinned quick-tunnel address.
$usesNgrok = Select-String -Path '.env.local-stack' -Pattern '^NGROK_DOMAIN=.+' -Quiet -ErrorAction SilentlyContinue
$url = if (-not $usesNgrok -and (Test-Path '.local-public-url')) { (Get-Content '.local-public-url' -Raw).Trim() } else { '' }
if ($url) { & (Join-Path $PSScriptRoot 'start-local.ps1') -PublicUrl $url } else { & (Join-Path $PSScriptRoot 'start-local.ps1') }
