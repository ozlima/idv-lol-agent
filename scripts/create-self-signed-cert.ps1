param(
    [string]$Subject = "CN=IDV Tracker Dev",
    [string]$FriendlyName = "IDV Tracker Dev Code Signing",
    [int]$Years = 3,
    [string]$ExportDir = "certs",
    [switch]$TrustLocal
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$exportPath = Join-Path $repoRoot $ExportDir
New-Item -ItemType Directory -Path $exportPath -Force | Out-Null

$cert = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject $Subject `
    -FriendlyName $FriendlyName `
    -KeyAlgorithm RSA `
    -KeyLength 3072 `
    -HashAlgorithm SHA256 `
    -KeyUsage DigitalSignature `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -NotAfter (Get-Date).AddYears($Years)

$cerPath = Join-Path $exportPath "IDV-Tracker-Dev-CodeSigning.cer"
Export-Certificate -Cert $cert -FilePath $cerPath -Force | Out-Null

if ($TrustLocal) {
    Import-Certificate -FilePath $cerPath -CertStoreLocation "Cert:\CurrentUser\Root" | Out-Null
    Import-Certificate -FilePath $cerPath -CertStoreLocation "Cert:\CurrentUser\TrustedPublisher" | Out-Null
}

Write-Host "Certificado criado."
Write-Host "Thumbprint: $($cert.Thumbprint)"
Write-Host "Public cert: $cerPath"
Write-Host "Private key: Cert:\CurrentUser\My\$($cert.Thumbprint)"
if ($TrustLocal) {
    Write-Host "Este usuario do Windows agora confia no certificado para testes locais."
}