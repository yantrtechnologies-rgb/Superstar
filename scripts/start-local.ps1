<#
Starts the full Superstar stack on Windows without Docker:
PostgreSQL (.local-postgres), Temporal dev server, worker, API and web,
plus an optional Cloudflare tunnel so OAuth callbacks reach this PC.

Usage (from the Superstar folder):
  powershell -ExecutionPolicy Bypass -File scripts\start-local.ps1
  powershell -ExecutionPolicy Bypass -File scripts\start-local.ps1 -PublicUrl https://superstar.example.com
  powershell -ExecutionPolicy Bypass -File scripts\start-local.ps1 -NoTunnel

Prerequisites: run `pnpm install --frozen-lockfile`, `pnpm db:generate` and `pnpm build` once.
Secrets come from apps\web\.env.local and an optional root .env.local-stack (same KEY=VALUE format).
Install Temporal with `winget install Temporal.TemporalCLI` and cloudflared with `winget install Cloudflare.cloudflared`.
Redis is only needed by the REST API rate limiter (SDK, CLI and MCP clients).
#>
param(
  [string]$PublicUrl = '',
  [switch]$NoTunnel,
  [string]$PgBin = 'C:\Program Files\PostgreSQL\16\bin',
  [int]$PgPort = 55433
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$links = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links'
if (Test-Path $links) { $env:Path = "$links;$env:Path" }

function Import-EnvFile([string]$Path) {
  if (-not (Test-Path $Path)) { return }
  foreach ($line in Get-Content $Path) {
    $t = $line.Trim()
    if (-not $t -or $t.StartsWith('#') -or -not $t.Contains('=')) { continue }
    $i = $t.IndexOf('=')
    $k = $t.Substring(0, $i).Trim(); $v = $t.Substring($i + 1).Trim().Trim('"')
    [Environment]::SetEnvironmentVariable($k, $v, 'Process')
  }
}
function Test-Port([int]$Port) {
  $c = New-Object Net.Sockets.TcpClient
  try { $c.Connect('127.0.0.1', $Port); return $true } catch { return $false } finally { $c.Dispose() }
}
function Start-Logged([string]$Name, [string]$File, [string[]]$ArgList, [string]$Cwd = $Root) {
  $out = Join-Path $Root ".local-$Name.stdout.log"; $err = Join-Path $Root ".local-$Name.stderr.log"
  $quoted = $ArgList | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }
  Start-Process -FilePath $File -ArgumentList $quoted -WorkingDirectory $Cwd -WindowStyle Hidden `
    -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
}

Import-EnvFile (Join-Path $Root 'apps\web\.env.local')
Import-EnvFile (Join-Path $Root '.env.local-stack')
if (-not $env:TEMPORAL_ADDRESS) { $env:TEMPORAL_ADDRESS = 'localhost:7233' }
if (-not $env:REDIS_URL) { $env:REDIS_URL = 'redis://localhost:6379' }
# OBJECT_STORAGE_PROVIDER=aws uses Amazon S3 with the AWS_PROFILE sign-in (no endpoint, no static keys).
$AwsStorage = $env:OBJECT_STORAGE_PROVIDER -eq 'aws'
if ($AwsStorage) {
  if (-not $env:OBJECT_STORAGE_BUCKET -or -not $env:OBJECT_STORAGE_REGION) { throw 'OBJECT_STORAGE_PROVIDER=aws needs OBJECT_STORAGE_BUCKET and OBJECT_STORAGE_REGION in .env.local-stack' }
  Remove-Item Env:OBJECT_STORAGE_ENDPOINT, Env:OBJECT_STORAGE_ACCESS_KEY, Env:OBJECT_STORAGE_SECRET_KEY -ErrorAction SilentlyContinue
} else {
  if (-not $env:OBJECT_STORAGE_ENDPOINT) { $env:OBJECT_STORAGE_ENDPOINT = 'http://127.0.0.1:9000' }
  if (-not $env:OBJECT_STORAGE_BUCKET) { $env:OBJECT_STORAGE_BUCKET = 'cadencedesk' }
  if (-not $env:OBJECT_STORAGE_ACCESS_KEY) { $env:OBJECT_STORAGE_ACCESS_KEY = 'cadencedesk' }
  if (-not $env:OBJECT_STORAGE_SECRET_KEY) { $env:OBJECT_STORAGE_SECRET_KEY = 'cadencedesk-local' }
  if (-not $env:OBJECT_STORAGE_REGION) { $env:OBJECT_STORAGE_REGION = 'us-east-1' }
}
# A DATABASE_URL that points away from this PC (for example Amazon RDS) needs no local PostgreSQL.
$RemoteDb = $env:DATABASE_URL -and ($env:DATABASE_URL -notmatch '@(localhost|127\.0\.0\.1)[:/]')

# 1. PostgreSQL
if ($RemoteDb) {
  Write-Host ('Database: remote (' + ([uri]($env:DATABASE_URL -replace '^postgresql://[^@]+@', 'postgresql://')).Host + ')')
  # The AWS idle-stop function may have stopped it; start it and wait so the app can connect.
  if ($env:RDS_INSTANCE_ID) { & (Join-Path $PSScriptRoot 'aws-db.ps1') start }
}
elseif (Test-Port $PgPort) { Write-Host "PostgreSQL already listening on $PgPort" }
else {
  & (Join-Path $PgBin 'pg_ctl.exe') -D (Join-Path $Root '.local-postgres-test') -o "-p $PgPort -h localhost" -l (Join-Path $Root '.local-postgres.log') -w start
}

# Find working database credentials when DATABASE_URL is not configured
if (-not $env:DATABASE_URL) {
  $psql = Join-Path $PgBin 'psql.exe'; $env:PGCONNECT_TIMEOUT = '3'
  foreach ($u in @('cadencedesk:cadencedesk@localhost:PORT/cadencedesk', 'superstar:superstar@localhost:PORT/superstar', 'postgres:postgres@localhost:PORT/cadencedesk', 'postgres:postgres@localhost:PORT/superstar', 'postgres:postgres@localhost:PORT/postgres')) {
    $url = 'postgresql://' + $u.Replace('PORT', "$PgPort")
    $ErrorActionPreference = 'Continue'
    $tables = & $psql -X -t -A -c 'select count(*) from information_schema.tables where table_name ilike $$%workspace%$$' -d $url 2>$null
    $ok = $LASTEXITCODE -eq 0
    $ErrorActionPreference = 'Stop'
    if ($ok -and [int]("$tables".Trim()) -gt 0) { $env:DATABASE_URL = $url; break }
  }
  if (-not $env:DATABASE_URL) { throw 'Could not log in to PostgreSQL. Put DATABASE_URL=postgresql://USER:PASSWORD@localhost:55432/DBNAME in .env.local-stack' }
  Write-Host ('Database: ' + ($env:DATABASE_URL -replace ':[^:@/]+@', ':***@'))
}

# 2. Temporal (required for publishing, scheduling, AI jobs, RSS and webhooks)
if (Test-Port 7233) { Write-Host 'Temporal already listening on 7233' }
elseif (Get-Command temporal -ErrorAction SilentlyContinue) {
  Start-Logged 'temporal' 'temporal' @('server', 'start-dev', '--port', '7233', '--ui-port', '8233', '--db-filename', (Join-Path $Root '.local-temporal.db')) | Out-Null
  for ($i = 0; $i -lt 30 -and -not (Test-Port 7233); $i++) { Start-Sleep 1 }
} else { Write-Warning 'Temporal CLI not found. Install it with: winget install Temporal.TemporalCLI. Posts will not publish until the worker runs.' }

# Object storage for uploaded images and videos (Amazon S3, or MinIO / the local store)
if ($AwsStorage) { Write-Host "Object storage: Amazon S3 bucket $env:OBJECT_STORAGE_BUCKET ($env:OBJECT_STORAGE_REGION, profile $env:AWS_PROFILE)" }
elseif (Test-Port 9000) { Write-Host 'Object storage already listening on 9000' }
else {
  $findMinio = {
    $c = Get-Command minio -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    $pkgs = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
    if (Test-Path $pkgs) { $f = Get-ChildItem $pkgs -Recurse -Filter 'minio*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1; if ($f) { return $f.FullName } }
    foreach ($d in @("$env:ProgramFiles\MinIO", "$env:ProgramFiles\minio")) { $f = Get-ChildItem $d -Recurse -Filter 'minio*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1; if ($f) { return $f.FullName } }
    return $null
  }
  $minio = & $findMinio
  if ($minio) {
    Write-Host "Object storage: MinIO ($minio)"
    $env:MINIO_ROOT_USER = $env:OBJECT_STORAGE_ACCESS_KEY; $env:MINIO_ROOT_PASSWORD = $env:OBJECT_STORAGE_SECRET_KEY
    Start-Logged 'minio' $minio @('server', (Join-Path $Root '.local-minio'), '--address', '127.0.0.1:9000', '--console-address', '127.0.0.1:9001') | Out-Null
  } else {
    Write-Host 'Object storage: local development store (scripts\local-storage.mjs)'
    Start-Logged 'storage' 'node' @('scripts\local-storage.mjs') | Out-Null
  }
  for ($i = 0; $i -lt 20 -and -not (Test-Port 9000); $i++) { Start-Sleep 1 }
}
if (-not $AwsStorage -and (Test-Port 9000)) {
  $ErrorActionPreference = 'Continue'
  & node (Join-Path $Root 'scripts\ensure-bucket.mjs')
  $ErrorActionPreference = 'Stop'
}

if (-not (Test-Port 6379)) { Write-Warning 'Redis is not running on 6379. The web app and worker are unaffected; REST API key requests will return 503.' }

# 3. Public URL for OAuth callbacks
if ($PublicUrl) { $base = $PublicUrl.TrimEnd('/') }
elseif ($NoTunnel) { $base = 'http://localhost:3000' }
elseif ($env:NGROK_DOMAIN) {
  # Fixed free ngrok address (NGROK_DOMAIN=name.ngrok-free.app); the auth token lives in ngrok's own config.
  $domain = $env:NGROK_DOMAIN -replace '^https?://', '' -replace '/.*$', ''
  $base = "https://$domain"
  $running = $false
  try { $running = [bool]((Invoke-RestMethod 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 3).tunnels | Where-Object { $_.public_url -eq $base }) } catch { }
  if ($running) { Write-Host "ngrok already serving $base" }
  else {
    Get-Process ngrok -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    if (-not (Get-Command ngrok -ErrorAction SilentlyContinue)) { throw 'ngrok is not installed. Run: winget install Ngrok.Ngrok' }
    Start-Logged 'ngrok' 'ngrok' @('http', '--url', $base, 'http://127.0.0.1:3000', '--log', 'stdout') | Out-Null
    for ($i = 0; $i -lt 20 -and -not $running; $i++) {
      Start-Sleep 1
      try { $running = [bool]((Invoke-RestMethod 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 2).tunnels | Where-Object { $_.public_url -eq $base }) } catch { }
    }
    if (-not $running) { throw "ngrok did not start $base. Check .local-ngrok.stdout.log (auth token and reserved domain)." }
  }
}
elseif (Get-Command cloudflared -ErrorAction SilentlyContinue) {
  $log = Join-Path $Root '.local-cloudflared.stderr.log'
  if (Test-Path $log) { Remove-Item $log }
  Start-Logged 'cloudflared' 'cloudflared' @('tunnel', '--url', 'http://127.0.0.1:3000') | Out-Null
  $base = $null
  for ($i = 0; $i -lt 40 -and -not $base; $i++) {
    Start-Sleep 1
    if (Test-Path $log) { $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -First 1; if ($m) { $base = $m.Matches[0].Value } }
  }
  if (-not $base) { throw 'cloudflared did not report a tunnel URL. Check .local-cloudflared.stderr.log' }
} else { Write-Warning 'cloudflared not found; using http://localhost:3000. Meta and Instagram need a public HTTPS URL.'; $base = 'http://localhost:3000' }
$env:APP_URL = $base; $env:AUTH_URL = $base

# 4. Worker, API, web (built output)
if (-not (Test-Path 'apps\worker\dist\main.js')) { throw 'Run pnpm build first.' }
if (Test-Port 3002) { Write-Host 'Worker already running' } elseif (Test-Port 7233) { Start-Logged 'worker' 'node' @('apps\worker\dist\main.js') | Out-Null }
if (Test-Port 3001) { Write-Host 'API already running' } else { Start-Logged 'api' 'node' @('apps\api\dist\main.js') | Out-Null }
$webArgs = @()
if (-not $env:RESEND_API_KEY -and -not $env:SMTP_HOST) {
  # No email provider: capture sign-in emails to .local-preview-mail.jsonl instead of sending them.
  $env:CADENCEDESK_E2E_MAIL_FILE = Join-Path $Root '.local-preview-mail.jsonl'
  $env:RESEND_API_KEY = 'local-capture'; if (-not $env:EMAIL_FROM) { $env:EMAIL_FROM = 'Superstar <local@example.invalid>' }
  $webArgs += @('--import', '../../scripts/capture-resend.mjs')
}
$webArgs += @('node_modules\next\dist\bin\next', 'start', '-H', '127.0.0.1', '-p', '3000')
if (Test-Port 3000) { Write-Host 'Web already running on 3000 (restart it to apply new settings)' } else { Start-Logged 'web' 'node' $webArgs (Join-Path $Root 'apps\web') | Out-Null }

Start-Sleep 8
Write-Host ''
Write-Host "Superstar: $base"
foreach ($p in @(@('web', 3000), @('api', 3001), @('worker', 3002), @('temporal', 7233), @('postgres', $PgPort), @('storage', 9000))) {
  if ($p[0] -eq 'postgres' -and $RemoteDb) { Write-Host ('  {0,-9} {1}' -f 'postgres', 'remote (AWS RDS)'); continue }
  if ($p[0] -eq 'storage' -and $AwsStorage) { Write-Host ('  {0,-9} {1}' -f 'storage', 'Amazon S3'); continue }
  Write-Host ('  {0,-9} {1}' -f $p[0], $(if (Test-Port $p[1]) { 'up' } else { 'DOWN' }))
}
Write-Host ''
Write-Host 'Register these exact OAuth redirect URLs (they change whenever a quick tunnel restarts):'
foreach ($n in 'meta', 'youtube', 'linkedin', 'x') { Write-Host "  $base/api/connect/$n" }
if (-not $env:CADENCEDESK_E2E_MAIL_FILE) { if ($env:SMTP_HOST) { Write-Host "Email: sending through $env:SMTP_HOST as $env:SMTP_USER" } } else { Write-Host 'Sign-in links are written to .local-preview-mail.jsonl' }
