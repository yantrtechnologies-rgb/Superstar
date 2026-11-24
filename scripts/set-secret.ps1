<#
Saves one or more settings into .env.local-stack without showing their values on screen.
  powershell -ExecutionPolicy Bypass -File scripts\set-secret.ps1 X_CLIENT_ID X_CLIENT_SECRET
#>
param([Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)][string[]]$Names)
$ErrorActionPreference = 'Stop'
$file = Join-Path (Split-Path -Parent $PSScriptRoot) '.env.local-stack'
$lines = if (Test-Path $file) { [System.Collections.Generic.List[string]](Get-Content $file) } else { [System.Collections.Generic.List[string]]::new() }
foreach ($name in $Names) {
  if ($name -notmatch '^[A-Z][A-Z0-9_]*$') { throw "Invalid setting name: $name" }
  $secure = Read-Host "Paste $name (input is hidden), then press Enter" -AsSecureString
  $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)).Trim()
  if (-not $value) { Write-Host "Skipped $name (nothing entered)."; continue }
  $index = $lines.FindIndex([Predicate[string]] { param($l) $l.StartsWith("$name=") })
  if ($index -ge 0) { $lines[$index] = "$name=$value" } else { $lines.Add("$name=$value") }
  $value = $null
  Write-Host "Saved $name."
}
Set-Content -Path $file -Value $lines -Encoding utf8
Write-Host 'Done. You can close this tab.'
