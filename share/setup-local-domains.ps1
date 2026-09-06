# Maps friendly local domains to 127.0.0.1 in the Windows hosts file.
#
# Why this is needed: `*.localhost` is resolved specially by curl and browsers, but
# Node and Bun do NOT special-case it -- `fetch("http://tabi.localhost/")` fails there.
# Since coding agents use Node/Bun fetch, a real hosts entry is required.
#
# MUST run elevated:
#   Right-click PowerShell -> Run as Administrator, then:
#   powershell -ExecutionPolicy Bypass -File setup-local-domains.ps1
#
# Add your own names by appending to $Domains below, or pass them:
#   ... -File setup-local-domains.ps1 -Domains tabi.local,llm.local,myapi.local

param(
  [string[]]$Domains = @("tabi.local", "llm.local"),
  [switch]$Remove
)

$ErrorActionPreference = "Stop"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "ERROR: must run as Administrator (the hosts file is not user-writable)." -ForegroundColor Red
  exit 1
}

$hostsPath = "$env:SystemRoot\System32\drivers\etc\hosts"
$marker    = "# tabipool local domains"

Copy-Item $hostsPath "$hostsPath.bak" -Force
Write-Host "backed up hosts -> $hostsPath.bak"

# Drop any previous block so re-running is idempotent rather than appending duplicates.
$lines = Get-Content $hostsPath | Where-Object { $_ -notmatch [regex]::Escape($marker) }
foreach ($d in $Domains) {
  $lines = $lines | Where-Object { $_ -notmatch "^\s*127\.0\.0\.1\s+$([regex]::Escape($d))\s*$" }
}

if ($Remove) {
  Set-Content $hostsPath -Value $lines -Encoding ASCII
  Write-Host "removed: $($Domains -join ', ')"
} else {
  $block = @($marker) + ($Domains | ForEach-Object { "127.0.0.1 $_" })
  Set-Content $hostsPath -Value ($lines + $block) -Encoding ASCII
  Write-Host "added: $($Domains -join ', ')"
}

ipconfig /flushdns | Out-Null
Write-Host "dns cache flushed"
Write-Host ""
Write-Host "verify with:  node -e ""fetch('http://$($Domains[0])/_health').then(r=>r.text()).then(console.log)"""
