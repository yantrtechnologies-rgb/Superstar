# Runs a shell script on the Superstar server through Session Manager and prints its output.
# Usage: run-remote.ps1 -Script 'commands' [-TimeoutSeconds 1800]
param([Parameter(Mandatory)][string]$Script, [int]$TimeoutSeconds = 1800)
$ErrorActionPreference = 'Stop'
# Build output contains non-ASCII characters; make the AWS CLI emit UTF-8 on Windows.
$env:PYTHONIOENCODING = 'utf-8'; $env:PYTHONUTF8 = '1'; [Console]::OutputEncoding = [Text.Encoding]::UTF8
$p = @('--region', 'ap-southeast-2', '--profile', 'superstar', '--output', 'json')
$Instance = 'i-093a8f8824368995b'
$params = @{ commands = @($Script -replace "`r`n", "`n"); executionTimeout = @("$TimeoutSeconds") } | ConvertTo-Json -Compress
$file = Join-Path $env:TEMP 'superstar-ssm-params.json'; [IO.File]::WriteAllText($file, $params)
$cmd = aws ssm send-command --instance-ids $Instance --document-name AWS-RunShellScript --parameters "file://$file" `
  --timeout-seconds 60 --query Command.CommandId @p | ConvertFrom-Json
$deadline = (Get-Date).AddSeconds($TimeoutSeconds + 60)
do {
  Start-Sleep 5
  $inv = aws ssm get-command-invocation --command-id $cmd --instance-id $Instance @p 2>$null | ConvertFrom-Json
} while ($inv -and $inv.Status -in 'Pending', 'InProgress', 'Delayed' -and (Get-Date) -lt $deadline)
Write-Output "STATUS: $($inv.Status)"
Write-Output $inv.StandardOutputContent
if ($inv.StandardErrorContent) { Write-Output "--- stderr (last part)"; Write-Output $inv.StandardErrorContent }
