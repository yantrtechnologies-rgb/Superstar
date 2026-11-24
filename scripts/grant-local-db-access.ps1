<#
One-time helper: the local PostgreSQL cluster uses a password that was not recorded.
This briefly allows passwordless connections from 127.0.0.1 only, creates the login
superstar_app with a new random password and read/write access, saves DATABASE_URL to
.env.local-stack, then restores pg_hba.conf exactly as it was.
#>
param([string]$PgBin = 'C:\Program Files\PostgreSQL\16\bin', [int]$PgPort = 55433, [string]$DataDir = '.local-postgres-test')
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$data = Join-Path $Root $DataDir
$hba = Join-Path $data 'pg_hba.conf'
$backup = "$hba.before-superstar-grant"
$psql = Join-Path $PgBin 'psql.exe'; $pgctl = Join-Path $PgBin 'pg_ctl.exe'
Copy-Item $hba $backup -Force
try {
  $original = Get-Content $hba -Raw
  Set-Content -Path $hba -Value ("host all postgres 127.0.0.1/32 trust`r`n" + $original) -NoNewline -Encoding ascii
  & $pgctl reload -D $data | Out-Null
  Start-Sleep 2
  $common = @('-X', '-t', '-A', '-h', '127.0.0.1', '-p', "$PgPort", '-U', 'postgres')
  $dbs = & $psql @common -d postgres -c 'select datname from pg_database where not datistemplate'
  $target = $null
  foreach ($db in $dbs) {
    $db = "$db".Trim(); if (-not $db) { continue }
    $n = & $psql @common -d $db -c "select count(*) from information_schema.tables where table_schema='public' and table_name in ('Workspace','workspace','workspaces','User','users')"
    if ([int]("$n".Trim()) -gt 0) { $target = $db; break }
  }
  if (-not $target) { throw "No Superstar database found. Databases: $($dbs -join ', ')" }
  $pw = -join ((48..57) + (97..122) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
  $sql = "do `$`$ begin if not exists (select from pg_roles where rolname='superstar_app') then create role superstar_app login; end if; end `$`$; alter role superstar_app with login password '$pw'; grant pg_read_all_data, pg_write_all_data to superstar_app; grant connect, temporary on database `"$target`" to superstar_app;"
  & $psql @common -d $target -c $sql | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Creating the superstar_app login failed.' }
  $url = "postgresql://superstar_app:$pw@localhost:$PgPort/$target"
  $stack = Join-Path $Root '.env.local-stack'
  $lines = @(); if (Test-Path $stack) { $lines = Get-Content $stack | Where-Object { $_ -notmatch '^DATABASE_URL=' } }
  ($lines + "DATABASE_URL=$url") | Set-Content $stack -Encoding ascii
  Write-Host "Created login superstar_app for database $target and saved DATABASE_URL to .env.local-stack"
} finally {
  Copy-Item $backup $hba -Force
  & $pgctl reload -D $data | Out-Null
  Remove-Item $backup -Force
  Write-Host 'pg_hba.conf restored.'
}
