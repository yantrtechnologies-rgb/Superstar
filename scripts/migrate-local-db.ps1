<#
Applies pending Prisma migrations to the local database (.local-postgres-test, port 55433).
Table creation needs the database owner, whose password was never recorded, so this briefly allows
passwordless connections for the postgres role from 127.0.0.1 only and restores pg_hba.conf afterwards.
Skips everything when no migration is pending.
#>
param([string]$PgBin = 'C:\Program Files\PostgreSQL\16\bin', [int]$PgPort = 55433, [string]$DataDir = '.local-postgres-test', [string]$Database = 'superstar_local')
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$psql = Join-Path $PgBin 'psql.exe'; $pgctl = Join-Path $PgBin 'pg_ctl.exe'
$data = Join-Path $Root $DataDir
$hba = Join-Path $data 'pg_hba.conf'; $backup = "$hba.before-superstar-migrate"

# Which migrations exist on disk vs. are recorded as applied (readable with the app login)
$stack = Join-Path $Root '.env.local-stack'
$appUrl = (Get-Content $stack | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1) -replace '^DATABASE_URL=', ''
if ($appUrl -notmatch '@(localhost|127\.0\.0\.1)[:/]') {
  # Remote database (for example Amazon RDS): the app login owns it, so Prisma can migrate directly.
  $env:DATABASE_URL = $appUrl
  $usePnpm = [bool](Get-Command pnpm -ErrorAction SilentlyContinue)
  if ($usePnpm) { & pnpm --filter '@cadencedesk/data' migrate } else { & corepack pnpm --filter '@cadencedesk/data' migrate }
  if ($LASTEXITCODE -ne 0) { throw 'prisma migrate deploy failed against the remote database' }
  return
}
$onDisk = Get-ChildItem (Join-Path $Root 'packages\data\prisma\migrations') -Directory | Select-Object -ExpandProperty Name | Sort-Object
$ErrorActionPreference = 'Continue'
$applied = & $psql -X -t -A -d $appUrl -c 'select migration_name from _prisma_migrations where finished_at is not null' 2>$null
$hasTable = $LASTEXITCODE -eq 0
$ErrorActionPreference = 'Stop'
$pending = @($onDisk | Where-Object { $applied -notcontains $_ })
if ($hasTable -and $pending.Count -eq 0) { Write-Host 'Database is up to date.'; return }
Write-Host ("Pending migrations: " + ($pending -join ', '))

Copy-Item $hba $backup -Force
try {
  $original = Get-Content $hba -Raw
  Set-Content -Path $hba -Value ("host all postgres 127.0.0.1/32 trust`r`n" + $original) -NoNewline -Encoding ascii
  & $pgctl reload -D $data | Out-Null
  Start-Sleep 2
  $owner = "postgresql://postgres@127.0.0.1:$PgPort/$Database"
  if ($hasTable) {
    $env:DATABASE_URL = $owner
    $usePnpm = [bool](Get-Command pnpm -ErrorAction SilentlyContinue)
    if ($usePnpm) { & pnpm --filter '@cadencedesk/data' migrate } else { & corepack pnpm --filter '@cadencedesk/data' migrate }
    if ($LASTEXITCODE -ne 0) { throw 'prisma migrate deploy failed' }
  } else {
    # Database was created without Prisma's history table: apply only the new SQL files directly.
    foreach ($name in $pending | Where-Object { $_ -ge '20261120000000' }) {
      & $psql -X -v ON_ERROR_STOP=1 -d $owner -f (Join-Path $Root "packages\data\prisma\migrations\$name\migration.sql")
      if ($LASTEXITCODE -ne 0) { throw "Applying $name failed" }
    }
  }
  Write-Host 'Migrations applied.'
} finally {
  Copy-Item $backup $hba -Force
  & $pgctl reload -D $data | Out-Null
  Remove-Item $backup -Force
  Write-Host 'pg_hba.conf restored.'
}
