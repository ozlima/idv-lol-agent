param(
  [string]$Branch = "master"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Enum]::ToObject([Net.SecurityProtocolType], 3072 -bor 12288)

Write-Host "install-test v5" -ForegroundColor Yellow

$Repo = "ozlima/idv-lol-agent"
$NodeVersion = "22.11.0"
$SupabaseUrl = "https://tninlfmhruccphpncahs.supabase.co"
$SupabaseAnonKey = "sb_publishable_ILxcIFs_94-MnEc-AuDVVg_i8P0Eb1D"

$AppRoot = Join-Path $env:LOCALAPPDATA "IDV Tracker"
$RuntimeDir = Join-Path $AppRoot "runtime"
$NodeDir = Join-Path $RuntimeDir "node-v$NodeVersion-win-x64"
$NodeZip = Join-Path $RuntimeDir "node.zip"
$AgentDir = Join-Path $AppRoot "idv-lol-agent"
$SetupLog = Join-Path $AppRoot "setup-test.log"
$InstallLog = Join-Path $AgentDir "install.log"
$Bootstrap = Join-Path $AppRoot "IDV-Tracker.bat"
$StartupVbs = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup\IDV-LoL-Agent.vbs"

function Step([string]$Message) {
  $stamp = Get-Date -Format "dd/MM/yyyy HH:mm:ss"
  $line = "[$stamp] $Message"
  Write-Host $line -ForegroundColor Cyan
  Add-Content -LiteralPath $SetupLog -Value $line -Encoding UTF8
}

function Stop-OldInstall {
  Step "Fechando agents antigos..."
  $resolvedAppRoot = [System.IO.Path]::GetFullPath($AppRoot)
  $resolvedLocal = [System.IO.Path]::GetFullPath($env:LOCALAPPDATA)
  if (-not $resolvedAppRoot.StartsWith($resolvedLocal, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Caminho inseguro para limpeza: $resolvedAppRoot"
  }

  $current = $PID
  Get-CimInstance Win32_Process | Where-Object {
    $_.ProcessId -ne $current -and
    $_.CommandLine -and
    $_.CommandLine.Contains($resolvedAppRoot)
  } | ForEach-Object {
    Step "Encerrando processo antigo: $($_.ProcessId) $($_.Name)"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }

  if (Test-Path -LiteralPath $StartupVbs) {
    Step "Removendo inicializacao antiga"
    Remove-Item -LiteralPath $StartupVbs -Force -ErrorAction SilentlyContinue
  }
}

function Install-NodePortable {
  if (Test-Path -LiteralPath (Join-Path $NodeDir "node.exe")) {
    Step "Node.js portatil ja existe"
    return
  }

  Step "Baixando Node.js portatil $NodeVersion..."
  New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null
  $nodeUrl = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"
  Invoke-WebRequest -Uri $nodeUrl -OutFile $NodeZip

  if (Test-Path -LiteralPath $NodeDir) {
    Remove-Item -LiteralPath $NodeDir -Recurse -Force
  }
  Expand-Archive -LiteralPath $NodeZip -DestinationPath $RuntimeDir -Force
  Remove-Item -LiteralPath $NodeZip -Force
  Step "Node.js pronto"
}

function Download-Agent {
  Step "Baixando IDV Tracker do GitHub ($Branch)..."

  if (Test-Path -LiteralPath $AgentDir) { Remove-Item -LiteralPath $AgentDir -Recurse -Force }
  New-Item -ItemType Directory -Path $AgentDir -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $AgentDir "src") -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $AgentDir "IDV-Tracker-Installer") -Force | Out-Null

  $rawBase = "https://raw.githubusercontent.com/$Repo/$Branch"
  $agentFiles = @(
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "src/index.ts",
    "src/lcu.ts",
    "src/live-client.ts",
    "src/loading-analysis.ts",
    "src/post-game-analysis.ts",
    "src/publisher.ts",
    "src/riot-api.ts",
    "src/watch-ui.ts",
    "src/watch.ts",
    "IDV-Tracker-Installer/IDV-Tracker.bat"
  )

  Step "Baixando $($agentFiles.Count) arquivos de raw.githubusercontent.com..."
  foreach ($f in $agentFiles) {
    $url = "$rawBase/$f"
    $dest = Join-Path $AgentDir $f
    Write-Host "  GET $url" -ForegroundColor DarkGray
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
  }

  if (-not (Test-Path -LiteralPath (Join-Path $AgentDir "package.json"))) {
    throw "package.json nao foi baixado para $AgentDir"
  }

  $sha = ""
  try {
    $commitApi = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/commits/$Branch" -UseBasicParsing -Headers @{ "User-Agent" = "idv-installer" }
    $sha = $commitApi.sha
  } catch { }
  $versionValue = if ($sha) { $sha } else { "unknown" }
  $versionShort = if ($sha) { $sha.Substring(0,7) } else { "sha desconhecido" }
  Set-Content -LiteralPath (Join-Path $AgentDir ".idv-version") -Value $versionValue -Encoding UTF8
  Step "Arquivos baixados ($versionShort)"
}

function Install-Agent {
  Step "Configurando ambiente..."
  $env:PATH = "$NodeDir;$env:PATH"
  $env:NPM_CONFIG_UPDATE_NOTIFIER = "false"
  $env:NPM_CONFIG_FUND = "false"
  $env:NPM_CONFIG_AUDIT = "false"
  $env:NPM_CONFIG_LOGLEVEL = "error"
  Set-Content -LiteralPath (Join-Path $AgentDir ".env") -Value "SUPABASE_URL=$SupabaseUrl`r`nSUPABASE_ANON_KEY=$SupabaseAnonKey" -Encoding UTF8

  Step "Instalando pacotes npm..."
  Push-Location $AgentDir
  try {
    "IDV Tracker install-test" | Set-Content -LiteralPath $InstallLog -Encoding UTF8
    "node: $(& node.exe -v 2>&1)" | Add-Content -LiteralPath $InstallLog -Encoding UTF8
    "npm: $(& npm.cmd -v 2>&1)" | Add-Content -LiteralPath $InstallLog -Encoding UTF8
    "" | Add-Content -LiteralPath $InstallLog -Encoding UTF8

    "Tentando npm ci..." | Add-Content -LiteralPath $InstallLog -Encoding UTF8
    & npm.cmd ci --omit=dev --no-audit --no-fund --loglevel=error *>> $InstallLog
    $npmExit = $LASTEXITCODE

    if ($npmExit -ne 0) {
      "" | Add-Content -LiteralPath $InstallLog -Encoding UTF8
      "npm ci falhou com codigo $npmExit. Tentando npm install..." | Add-Content -LiteralPath $InstallLog -Encoding UTF8
      & npm.cmd install --omit=dev --no-audit --no-fund --loglevel=error *>> $InstallLog
      $npmExit = $LASTEXITCODE
    }

    if ($npmExit -ne 0) {
      $tail = (Get-Content -LiteralPath $InstallLog -Tail 80 | Where-Object { $_ -notmatch '^npm notice' }) -join "`n"
      if (-not $tail.Trim()) { $tail = "Sem erro detalhado no tail. Veja o install.log completo." }
      throw "Falha ao instalar pacotes npm (codigo $npmExit). Log: $InstallLog`n$tail"
    }
  } finally {
    Pop-Location
  }

  Step "Criando launcher e inicializacao com Windows..."
  Copy-Item -LiteralPath (Join-Path $AgentDir "IDV-Tracker-Installer\IDV-Tracker.bat") -Destination $Bootstrap -Force

  $startupDir = Split-Path -Parent $StartupVbs
  New-Item -ItemType Directory -Path $startupDir -Force | Out-Null
  $vbs = "Set o = CreateObject(""WScript.Shell"")`r`no.Run Chr(34) & ""$Bootstrap"" & Chr(34) & "" --run"", 0, False"
  Set-Content -LiteralPath $StartupVbs -Value $vbs -Encoding ASCII

  Step "Criando atalho de atualizacao na Area de Trabalho..."
  $desktop = [Environment]::GetFolderPath("Desktop")
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut((Join-Path $desktop "Atualizar IDV Tracker.lnk"))
  $lnk.TargetPath = "powershell.exe"
  $lnk.Arguments = '-NoProfile -ExecutionPolicy Bypass -Command "iex (iwr -UseB https://raw.githubusercontent.com/ozlima/idv-lol-agent/master/install-test.ps1).Content"'
  $lnk.WorkingDirectory = $env:USERPROFILE
  $lnk.WindowStyle = 1
  $lnk.Description = "Atualiza o IDV Tracker para a versao mais recente"
  $lnk.IconLocation = "powershell.exe,0"
  $lnk.Save()

  New-Item -ItemType File -Path (Join-Path $AgentDir ".installed") -Force | Out-Null
}

function Start-Agent {
  Step "Iniciando agent..."
  $shell = New-Object -ComObject WScript.Shell
  [void]$shell.Run("`"$Bootstrap`" --run", 0, $false)
  Start-Sleep -Seconds 3

  $running = Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -and
    $_.CommandLine.Contains($AgentDir) -and
    ($_.Name -eq "node.exe" -or $_.Name -eq "cmd.exe" -or $_.Name -eq "npm.cmd")
  }
  if (-not $running) {
    throw "Agent nao ficou rodando. Logs: $SetupLog e $InstallLog"
  }
}

try {
  New-Item -ItemType Directory -Path $AppRoot -Force | Out-Null
  Set-Content -LiteralPath $SetupLog -Value "IDV Tracker install-test" -Encoding UTF8

  Write-Host ""
  Write-Host "IDV Tracker - instalador de teste" -ForegroundColor Green
  Write-Host "Pasta: $AppRoot"
  Write-Host ""

  Stop-OldInstall
  Install-NodePortable
  Download-Agent
  Install-Agent
  Start-Agent

  Step "Instalacao concluida"
  Write-Host ""
  Write-Host "Pronto. O IDV Tracker esta instalado e rodando." -ForegroundColor Green
  Write-Host "Log: $SetupLog"
  Write-Host ""
} catch {
  $message = $_.Exception.Message
  Add-Content -LiteralPath $SetupLog -Value "ERRO: $message" -Encoding UTF8
  Write-Host ""
  Write-Host "ERRO: $message" -ForegroundColor Red
  Write-Host "Log: $SetupLog" -ForegroundColor Yellow
  if (Test-Path -LiteralPath $InstallLog) {
    Write-Host "Install log: $InstallLog" -ForegroundColor Yellow
  }
  exit 1
}
