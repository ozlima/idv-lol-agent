param([string]$Remote = "origin", [string]$Branch = "master")

$ErrorActionPreference = "Stop"

# 1. push do codigo
git push $Remote $Branch
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# 2. atualiza VERSION com o SHA que acabou de ir pro remote
$sha = (git rev-parse HEAD).Trim()
Set-Content -LiteralPath (Join-Path $PSScriptRoot "VERSION") -Value $sha -Encoding utf8
git add VERSION
$short = $sha.Substring(0, 7)
git commit -m "Update VERSION to $short" --no-verify
git push $Remote $Branch

# 3. reinicia watch-ui para pegar o novo VERSION do disco
pm2 restart idv-lol-watch-ui --update-env | Out-Null
Write-Host "VERSION -> $short  |  watch-ui reiniciado" -ForegroundColor Green
