# Saves your ngrok auth token into ngrok's own config without showing it on screen or in logs.
# Run: powershell -ExecutionPolicy Bypass -File scripts\ngrok-token.ps1
$secure = Read-Host 'Paste your ngrok auth token (input is hidden), then press Enter' -AsSecureString
$plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
if (-not $plain.Trim()) { Write-Host 'No token entered.'; exit 1 }
& ngrok config add-authtoken $plain.Trim() | Out-Null
$plain = $null
if ($LASTEXITCODE -eq 0) { Write-Host 'ngrok token saved. You can close this tab.' } else { Write-Host 'ngrok rejected the token. Copy it again from the dashboard and retry.'; exit 1 }
