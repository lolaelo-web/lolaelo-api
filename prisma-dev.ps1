# Load DEV + SHADOW env vars explicitly (no server start)
$env:DATABASE_URL = (Select-String .\.env.dev -Pattern '^DATABASE_URL=').Line.Split('=',2)[1].Trim('"')
$env:SHADOW_DATABASE_URL = (Select-String .\.env.dev -Pattern '^SHADOW_DATABASE_URL=').Line.Split('=',2)[1].Trim('"')

# Safety check
Write-Host "Using DEV DATABASE_URL:"
Write-Host $env:DATABASE_URL

Write-Host "Using SHADOW_DATABASE_URL:"
Write-Host $env:SHADOW_DATABASE_URL

# Run Prisma with DEV context
npx prisma migrate status
