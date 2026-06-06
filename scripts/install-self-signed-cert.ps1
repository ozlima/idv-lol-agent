param(
    [string]$CertPath = "certs\IDV-Tracker-Dev-CodeSigning.cer"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not [System.IO.Path]::IsPathRooted($CertPath)) {
    $CertPath = Join-Path $repoRoot $CertPath
}

if (-not (Test-Path -LiteralPath $CertPath)) {
    throw "Certificado nao encontrado: $CertPath"
}

Import-Certificate -FilePath $CertPath -CertStoreLocation "Cert:\CurrentUser\Root" | Out-Null
Import-Certificate -FilePath $CertPath -CertStoreLocation "Cert:\CurrentUser\TrustedPublisher" | Out-Null

Write-Host "Certificado instalado para o usuario atual."
Write-Host "Agora rode o IDV-Tracker-Setup.exe assinado pelo mesmo certificado."