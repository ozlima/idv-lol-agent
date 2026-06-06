param(
    [string]$InstallerPath = "dist\IDV-Tracker-Setup.exe",
    [string]$Thumbprint = "",
    [string]$Subject = "IDV Tracker Dev",
    [string]$OutputPath = "dist\IDV-Tracker-Setup-signed.exe"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Resolve-RepoPath([string]$Path) {
    if ([System.IO.Path]::IsPathRooted($Path)) { return $Path }
    return (Join-Path $repoRoot $Path)
}

function Find-SignTool {
    $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    $kits = @(
        "$env:ProgramFiles(x86)\Windows Kits\10\bin",
        "$env:ProgramFiles\Windows Kits\10\bin"
    )
    foreach ($kit in $kits) {
        if (Test-Path -LiteralPath $kit) {
            $found = Get-ChildItem -Path $kit -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
                Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
                Sort-Object FullName -Descending |
                Select-Object -First 1
            if ($found) { return $found.FullName }
        }
    }
    return $null
}

$installer = Resolve-RepoPath $InstallerPath
$output = Resolve-RepoPath $OutputPath
if (-not (Test-Path -LiteralPath $installer)) {
    throw "Installer nao encontrado: $installer"
}

New-Item -ItemType Directory -Path (Split-Path -Parent $output) -Force | Out-Null
Copy-Item -LiteralPath $installer -Destination $output -Force

if (-not $Thumbprint) {
    $cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert |
        Where-Object { $_.Subject -like "*$Subject*" -and $_.HasPrivateKey } |
        Sort-Object NotAfter -Descending |
        Select-Object -First 1
    if (-not $cert) {
        throw "Nenhum certificado code signing com private key encontrado para '$Subject'. Rode scripts\create-self-signed-cert.ps1 primeiro."
    }
    $Thumbprint = $cert.Thumbprint
}

$certToSign = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert |
    Where-Object { $_.Thumbprint -eq $Thumbprint -and $_.HasPrivateKey } |
    Select-Object -First 1
if (-not $certToSign) {
    throw "Certificado com private key nao encontrado em Cert:\CurrentUser\My: $Thumbprint"
}

$signtool = Find-SignTool
Write-Host "Assinando: $output"
Write-Host "Cert: $Thumbprint"

if ($signtool) {
    & $signtool sign /fd SHA256 /sha1 $Thumbprint /tr http://timestamp.digicert.com /td SHA256 $output
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Timestamp falhou. Tentando assinatura sem timestamp para teste local."
        & $signtool sign /fd SHA256 /sha1 $Thumbprint $output
        if ($LASTEXITCODE -ne 0) { throw "Falha ao assinar o installer." }
    }

    & $signtool verify /pa /v $output
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Verificacao /pa falhou. Se for self-signed, instale o .cer no Root e TrustedPublisher do usuario atual."
    }
} else {
    Write-Warning "signtool.exe nao encontrado. Usando Set-AuthenticodeSignature sem timestamp."
    $result = Set-AuthenticodeSignature -FilePath $output -Certificate $certToSign -HashAlgorithm SHA256
    if ($result.Status -ne "Valid") {
        throw "Falha ao assinar via Set-AuthenticodeSignature: $($result.Status) $($result.StatusMessage)"
    }
}

$signature = Get-AuthenticodeSignature -FilePath $output
Write-Host "Status assinatura: $($signature.Status)"
Write-Host "Assinado por: $($signature.SignerCertificate.Subject)"
Write-Host "EXE assinado: $output"