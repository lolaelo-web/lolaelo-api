# dev.ps1 - run server on DEV DB + DEV shadow DB

$ErrorActionPreference = "Stop"

# Load DATABASE_URL + SHADOW_DATABASE_URL + ADMIN_TOKEN from .env.dev
Get-Content "$PSScriptRoot\.env.dev" | ForEach-Object {
    if ($_ -match '^\s*(DATABASE_URL|SHADOW_DATABASE_URL|ADMIN_TOKEN)\s*=\s*"(.*)"\s*$') {
    Set-Item -Path ("Env:\" + $matches[1]) -Value $matches[2]
    }
    elseif ($_ -match '^\s*(DATABASE_URL|SHADOW_DATABASE_URL|ADMIN_TOKEN)\s*=\s*(\S+)\s*$') {
    Set-Item -Path ("Env:\" + $matches[1]) -Value $matches[2]
    }
}

Write-Host "Running on DEV:"
Write-Host ("DATABASE_URL=" + ($env:DATABASE_URL -replace '://.*?:.*?@', '://***:***@'))
Write-Host ("SHADOW_DATABASE_URL=" + ($env:SHADOW_DATABASE_URL -replace '://.*?:.*?@', '://***:***@'))
Write-Host ("ADMIN_TOKEN loaded=" + ($(if ($env:ADMIN_TOKEN) { "yes" } else { "no" })))

npm run dev
