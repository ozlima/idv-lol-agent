# Assinatura self-signed para teste

Este fluxo e para distribuir o IDV Tracker para um grupo pequeno. Ele nao substitui um certificado publico de Code Signing, mas reduz alertas em maquinas que confiarem no seu certificado.

## 1. Criar o certificado na sua maquina

```powershell
powershell -ExecutionPolicy Bypass -File scripts\create-self-signed-cert.ps1 -TrustLocal
```

Isso cria:

- chave privada no seu Windows: `Cert:\CurrentUser\My`
- certificado publico para mandar aos testers: `certs\IDV-Tracker-Dev-CodeSigning.cer`

Nunca exporte/mande a chave privada.

## 2. Assinar o EXE

Coloque o installer em `dist\IDV-Tracker-Setup.exe` e rode:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\sign-installer-self-signed.ps1
```

Saida esperada:

```text
dist\IDV-Tracker-Setup-signed.exe
```

## 3. O que mandar para cada pessoa

Envie estes dois arquivos:

```text
certs\IDV-Tracker-Dev-CodeSigning.cer
dist\IDV-Tracker-Setup-signed.exe
```

Na maquina da pessoa, ela deve instalar o certificado uma vez:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-self-signed-cert.ps1 -CertPath .\IDV-Tracker-Dev-CodeSigning.cer
```

Depois ela abre o `IDV-Tracker-Setup-signed.exe`.

## Observacao importante

Self-signed so e confiavel para quem instalar o `.cer`. Para distribuicao publica sem esse passo, precisa certificado publico pago ou programa gratuito como SignPath Foundation.