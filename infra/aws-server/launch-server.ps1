# Launches the Superstar server (once) and gives it a fixed public IP. Region: ap-southeast-2.
$ErrorActionPreference = 'Stop'
$R = 'ap-southeast-2'; $Prof = 'superstar'
$p = @('--region', $R, '--profile', $Prof, '--output', 'text')
$Subnet = 'subnet-0792e4c65c466d7bb'   # ap-southeast-2c, same zone as superstar-db
$Sg = 'sg-0e5894d78362b65a3'
$Ami = aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 --query Parameter.Value @p

$Id = aws ec2 describe-instances --filters 'Name=tag:Name,Values=superstar-web' 'Name=instance-state-name,Values=pending,running,stopping,stopped' --query 'Reservations[0].Instances[0].InstanceId' @p
if (-not $Id -or $Id -eq 'None') {
  # User data must use Unix line endings.
  $ud = (Get-Content (Join-Path $PSScriptRoot 'user-data.sh') -Raw) -replace "`r`n", "`n"
  $udFile = Join-Path $env:TEMP 'superstar-user-data.sh'; [IO.File]::WriteAllText($udFile, $ud)
  for ($i = 0; $i -lt 6; $i++) {
    $Id = aws ec2 run-instances --image-id $Ami --instance-type t4g.small --subnet-id $Subnet --security-group-ids $Sg `
      --iam-instance-profile Name=superstar-web-role --credit-specification CpuCredits=standard `
      --metadata-options 'HttpTokens=required,HttpEndpoint=enabled,HttpPutResponseHopLimit=2' `
      --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=25,VolumeType=gp3,Encrypted=true,DeleteOnTermination=true}' `
      --user-data "file://$udFile" `
      --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=superstar-web},{Key=project,Value=superstar}]' 'ResourceType=volume,Tags=[{Key=project,Value=superstar}]' `
      --query 'Instances[0].InstanceId' @p 2>&1
    if ($LASTEXITCODE -eq 0) { break }
    if ("$Id" -notmatch 'Invalid IAM Instance Profile') { throw "run-instances failed: $Id" }
    Write-Host 'waiting for the new instance profile to propagate...'; Start-Sleep 10
  }
  Write-Host "launched $Id"
} else { Write-Host "instance $Id exists" }
aws ec2 wait instance-running --instance-ids $Id --region $R --profile $Prof

$Eip = aws ec2 describe-addresses --filters 'Name=tag:Name,Values=superstar-web' --query 'Addresses[0].AllocationId' @p
if (-not $Eip -or $Eip -eq 'None') {
  $Eip = aws ec2 allocate-address --domain vpc --tag-specifications 'ResourceType=elastic-ip,Tags=[{Key=Name,Value=superstar-web},{Key=project,Value=superstar}]' --query AllocationId @p
}
aws ec2 associate-address --allocation-id $Eip --instance-id $Id @p | Out-Null
$Ip = aws ec2 describe-addresses --allocation-ids $Eip --query 'Addresses[0].PublicIp' @p
Write-Host "INSTANCE=$Id"
Write-Host "PUBLIC_IP=$Ip"
