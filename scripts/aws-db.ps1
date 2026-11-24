<#
Status, start or stop the Superstar RDS database.
  powershell -ExecutionPolicy Bypass -File scripts\aws-db.ps1 status
  powershell -ExecutionPolicy Bypass -File scripts\aws-db.ps1 start   # starts it and waits until it accepts connections
  powershell -ExecutionPolicy Bypass -File scripts\aws-db.ps1 stop
  powershell -ExecutionPolicy Bypass -File scripts\aws-db.ps1 allow-ip  # point the 'Developer PC' firewall rule at this PC's current IP
'start' also does allow-ip, so start-local.ps1 keeps working after the home IP changes.
Reads RDS_INSTANCE_ID, RDS_REGION and AWS_PROFILE from .env.local-stack.
The database runs continuously. (The AWS idle-stop function from infra\db-idle-stop was removed on 2026-11-23 at the owner's request.)
#>
param([ValidateSet('status', 'start', 'stop', 'allow-ip')][string]$Action = 'status')
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
foreach ($line in Get-Content (Join-Path $Root '.env.local-stack') -ErrorAction SilentlyContinue) {
  if ($line -match '^(RDS_INSTANCE_ID|RDS_REGION|AWS_PROFILE)=(.*)$' -and -not [Environment]::GetEnvironmentVariable($Matches[1])) {
    Set-Item "Env:$($Matches[1])" $Matches[2]
  }
}
$Id = if ($env:RDS_INSTANCE_ID) { $env:RDS_INSTANCE_ID } else { 'superstar-db' }
$Region = if ($env:RDS_REGION) { $env:RDS_REGION } else { 'ap-southeast-2' }
$Profile = if ($env:AWS_PROFILE) { $env:AWS_PROFILE } else { 'superstar' }
$Aws = Join-Path $env:LOCALAPPDATA 'Programs\Amazon\AWSCLIV2\aws.exe'
if (-not (Test-Path $Aws)) { $cmd = Get-Command aws -ErrorAction SilentlyContinue; if ($cmd) { $Aws = $cmd.Source } else { throw 'AWS CLI not found.' } }
$common = @('--db-instance-identifier', $Id, '--region', $Region, '--profile', $Profile)

function Get-DbStatus {
  $out = & $Aws rds describe-db-instances @common --query 'DBInstances[0].DBInstanceStatus' --output text 2>&1
  if ($LASTEXITCODE -ne 0) {
    if ("$out" -match 'credentials|expired|login|token') { throw "AWS sign-in expired. Run: aws login --profile $Profile" }
    throw "Could not read the database status: $out"
  }
  return "$out".Trim()
}

# Home IP addresses change (router restarts), so keep the database firewall pointed at this PC.
# Only rules labelled 'Developer PC' are replaced; any other rule is left alone.
function Sync-FirewallIp {
  try { $ip = "$(Invoke-RestMethod 'https://checkip.amazonaws.com' -TimeoutSec 15)".Trim() } catch { Write-Warning "Could not look up this PC's public IP; database firewall not checked."; return }
  if ($ip -notmatch '^\d{1,3}(\.\d{1,3}){3}$') { Write-Warning "Unexpected public IP '$ip'; database firewall not checked."; return }
  $info = & $Aws rds describe-db-instances @common --query 'DBInstances[0].{port:Endpoint.Port,sgs:VpcSecurityGroups[].VpcSecurityGroupId}' --output json 2>&1 | ConvertFrom-Json
  $port = if ($info.port) { [int]$info.port } else { 5432 }
  foreach ($sg in @($info.sgs)) {
    $rules = & $Aws ec2 describe-security-groups --group-ids $sg --region $Region --profile $Profile --query "SecurityGroups[0].IpPermissions[?FromPort==``$port``].IpRanges[]" --output json | ConvertFrom-Json
    $mine = @($rules | Where-Object { $_.Description -eq 'Developer PC' } | ForEach-Object { $_.CidrIp })
    if ($mine -contains "$ip/32") { Write-Host "Database firewall: allows this PC ($ip)"; continue }
    & $Aws ec2 authorize-security-group-ingress --group-id $sg --region $Region --profile $Profile --ip-permissions "IpProtocol=tcp,FromPort=$port,ToPort=$port,IpRanges=[{CidrIp=$ip/32,Description='Developer PC'}]" --output text | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not allow $ip in database firewall $sg." }
    foreach ($old in $mine) {
      & $Aws ec2 revoke-security-group-ingress --group-id $sg --region $Region --profile $Profile --ip-permissions "IpProtocol=tcp,FromPort=$port,ToPort=$port,IpRanges=[{CidrIp=$old}]" --output text | Out-Null
    }
    Write-Host ("Database firewall: now allows this PC ($ip)" + $(if ($mine) { "; removed " + ($mine -join ', ') } else { '' }))
  }
}

$status = Get-DbStatus
switch ($Action) {
  'status' { Write-Host "Database ${Id}: $status" }
  'stop' {
    if ($status -eq 'available') { & $Aws rds stop-db-instance @common --output text --query 'DBInstance.DBInstanceStatus' | Out-Null; Write-Host "Stopping $Id (takes a few minutes)." }
    else { Write-Host "Database ${Id} is $status; nothing to stop." }
  }
  'start' {
    if ($status -eq 'available') { Write-Host "Database ${Id}: available"; break }
    if ($status -eq 'stopping') {
      Write-Host "Database $Id is stopping; waiting for it to finish before starting it again..."
      & $Aws rds wait db-instance-stopped @common
      $status = 'stopped'
    }
    if ($status -eq 'stopped') {
      & $Aws rds start-db-instance @common --output text --query 'DBInstance.DBInstanceStatus' | Out-Null
      Write-Host "Starting $Id. This usually takes 5-10 minutes..."
    } else { Write-Host "Database $Id is $status; waiting until it is available..." }
    & $Aws rds wait db-instance-available @common
    if ($LASTEXITCODE -ne 0) { throw "Database $Id did not become available." }
    Write-Host "Database ${Id}: available"
  }
  'allow-ip' { Write-Host "Database ${Id}: $status" }
}
if ($Action -in 'start', 'allow-ip') { Sync-FirewallIp }
