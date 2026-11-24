# Creates the AWS pieces the Superstar server needs (idempotent; safe to re-run). Region: ap-southeast-2.
#  - security group superstar-web (80/443 in, no SSH; managed through Session Manager)
#  - database rule: superstar-web may reach superstar-db on 5432
#  - IAM role + instance profile superstar-web-role (SSM, media bucket, database start, own settings)
#  - SecureString parameter /superstar/env with the production settings (never printed)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$R = 'ap-southeast-2'; $Prof = 'superstar'
$p = @('--region', $R, '--profile', $Prof, '--output', 'text')
$Vpc = 'vpc-054a692781b535a83'; $DbSg = 'sg-0cbc9139c4bbcaf3e'; $Bucket = 'superstar-media-569659729378'
$Account = aws sts get-caller-identity --query Account @p
$Tmp = Join-Path $env:TEMP 'superstar-aws'; New-Item -ItemType Directory -Force $Tmp | Out-Null

# 1. Security group for the web server
$Sg = aws ec2 describe-security-groups --filters "Name=group-name,Values=superstar-web" "Name=vpc-id,Values=$Vpc" --query 'SecurityGroups[0].GroupId' @p
if (-not $Sg -or $Sg -eq 'None') {
  $Sg = aws ec2 create-security-group --group-name superstar-web --description 'Superstar web server: HTTP and HTTPS only' --vpc-id $Vpc `
    --tag-specifications 'ResourceType=security-group,Tags=[{Key=project,Value=superstar}]' --query GroupId @p
  aws ec2 authorize-security-group-ingress --group-id $Sg --ip-permissions `
    'IpProtocol=tcp,FromPort=80,ToPort=80,IpRanges=[{CidrIp=0.0.0.0/0,Description=HTTP}]' `
    'IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0,Description=HTTPS}]' @p | Out-Null
  Write-Host "created security group $Sg"
} else { Write-Host "security group $Sg exists" }

# 2. Let the server reach the database
$has = aws ec2 describe-security-groups --group-ids $DbSg --query "SecurityGroups[0].IpPermissions[?FromPort==``5432``].UserIdGroupPairs[].GroupId" @p
if ("$has" -notmatch $Sg) {
  aws ec2 authorize-security-group-ingress --group-id $DbSg --ip-permissions "IpProtocol=tcp,FromPort=5432,ToPort=5432,UserIdGroupPairs=[{GroupId=$Sg,Description=Superstar web server}]" @p | Out-Null
  Write-Host 'database now accepts the web server'
} else { Write-Host 'database rule exists' }

# 3. Server role and instance profile
@"
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole",
"Condition":{"StringEquals":{"aws:SourceAccount":"$Account"}}}]}
"@ | Set-Content "$Tmp\trust.json" -Encoding ascii
@"
{"Version":"2012-10-17","Statement":[
{"Sid":"MediaObjects","Effect":"Allow","Action":["s3:GetObject","s3:PutObject"],"Resource":"arn:aws:s3:::$Bucket/*"},
{"Sid":"MediaList","Effect":"Allow","Action":"s3:ListBucket","Resource":"arn:aws:s3:::$Bucket"},
{"Sid":"DatabaseWake","Effect":"Allow","Action":["rds:DescribeDBInstances","rds:StartDBInstance"],"Resource":"arn:aws:rds:${R}:${Account}:db:superstar-db"},
{"Sid":"OwnSettings","Effect":"Allow","Action":["ssm:GetParameter"],"Resource":"arn:aws:ssm:${R}:${Account}:parameter/superstar/*"}]}
"@ | Set-Content "$Tmp\policy.json" -Encoding ascii
$null = aws iam get-role --role-name superstar-web-role --profile $Prof 2>$null
if ($LASTEXITCODE -ne 0) {
  aws iam create-role --role-name superstar-web-role --assume-role-policy-document "file://$Tmp\trust.json" --tags Key=project,Value=superstar --profile $Prof | Out-Null
  aws iam attach-role-policy --role-name superstar-web-role --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore --profile $Prof
  Write-Host 'created role superstar-web-role'
}
aws iam put-role-policy --role-name superstar-web-role --policy-name superstar-app --policy-document "file://$Tmp\policy.json" --profile $Prof
$null = aws iam get-instance-profile --instance-profile-name superstar-web-role --profile $Prof 2>$null
if ($LASTEXITCODE -ne 0) {
  aws iam create-instance-profile --instance-profile-name superstar-web-role --profile $Prof | Out-Null
  aws iam add-role-to-instance-profile --instance-profile-name superstar-web-role --role-name superstar-web-role --profile $Prof
  Write-Host 'created instance profile'
}

# 4. Production settings: PC settings with the public address changed; PC-only entries dropped.
$skip = '^(AWS_PROFILE|NGROK_DOMAIN|APP_URL|AUTH_URL|CADENCEDESK_E2E_MAIL_FILE)='
$lines = @()
foreach ($f in 'apps\web\.env.local', '.env.local-stack') {
  $lines += Get-Content (Join-Path $Root $f) | Where-Object { $_ -match '^[A-Z0-9_]+=' -and $_ -notmatch $skip }
}
$lines += 'APP_URL=https://superstar.xolnet.in', 'AUTH_URL=https://superstar.xolnet.in', 'NODE_ENV=production', 'TEMPORAL_ADDRESS=localhost:7233'
($lines -join "`n") | Set-Content "$Tmp\env.txt" -Encoding utf8 -NoNewline
aws ssm put-parameter --name /superstar/env --type SecureString --value "file://$Tmp\env.txt" --overwrite --tier Standard @p | Out-Null
Remove-Item "$Tmp\env.txt" -Force
Write-Host "saved encrypted settings /superstar/env ($($lines.Count) entries)"
Write-Host "SECURITY_GROUP=$Sg"
