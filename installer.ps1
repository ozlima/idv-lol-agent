$TargetDir = $env:IDV_TARGET_DIR
$IconPath  = $env:IDV_ICON_PATH
$SupaUrl   = $env:SUPABASE_URL
$SupaKey   = $env:SUPABASE_ANON_KEY
$SetupLog  = $env:IDV_SETUP_LOG
$StartupVbs = [System.IO.Path]::Combine(
    $env:APPDATA,
    "Microsoft\Windows\Start Menu\Programs\Startup\IDV-LoL-Agent.vbs"
)

$InstallerMutexCreated = $false
$InstallerMutex = New-Object System.Threading.Mutex($true, "Local\IDVTrackerInstaller", [ref]$InstallerMutexCreated)
if (-not $InstallerMutexCreated) {
    exit 0
}

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

[xml]$XAML = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="IDV Tracker" Width="440" Height="520"
        WindowStartupLocation="CenterScreen"
        ResizeMode="NoResize" WindowStyle="None"
        Background="#0A0C14"
        Topmost="True">
  <Border Background="#0A0C14" CornerRadius="14"
          BorderBrush="#141C2E" BorderThickness="1">
    <Border.Effect>
      <DropShadowEffect Color="#000000" BlurRadius="50"
                        ShadowDepth="0" Opacity="0.95"/>
    </Border.Effect>
    <Grid>

      <!-- close -->
      <Button x:Name="BtnClose" Content="&#x2715;"
              HorizontalAlignment="Right" VerticalAlignment="Top"
              Margin="0,14,16,0" Background="Transparent" BorderThickness="0"
              Foreground="#2A3450" FontSize="13" Cursor="Hand"
              Width="28" Height="28">
        <Button.Template>
          <ControlTemplate TargetType="Button">
            <Border Background="{TemplateBinding Background}" CornerRadius="5">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
          </ControlTemplate>
        </Button.Template>
      </Button>

      <!-- content -->
      <StackPanel VerticalAlignment="Center" HorizontalAlignment="Center"
                  Width="340" Margin="0,-18,0,0">

        <!-- icon with cyan glow -->
        <Border HorizontalAlignment="Center" Margin="0,0,0,24">
          <Border.Effect>
            <DropShadowEffect Color="#22D3EE" BlurRadius="28"
                              ShadowDepth="0" Opacity="0.45"/>
          </Border.Effect>
          <Image x:Name="ImgIcon" Height="96" Width="96"
                 RenderOptions.BitmapScalingMode="HighQuality"/>
        </Border>

        <!-- title -->
        <TextBlock Text="IDV Tracker"
                   FontSize="28" FontWeight="Bold" Foreground="#E2E8F0"
                   HorizontalAlignment="Center" Margin="0,0,0,6"
                   FontFamily="Segoe UI"/>

        <!-- tagline -->
        <TextBlock Text="MONITOR DE PARTIDAS"
                   FontSize="10" Foreground="#3C537A"
                   HorizontalAlignment="Center" Margin="0,0,0,34"
                   FontFamily="Segoe UI"/>

        <!-- installing -->
        <StackPanel x:Name="PanelInstalling">
          <TextBlock x:Name="TxtInstallStatus"
                     Text="&#x1F6E0; Instalando o IDV Tracker"
                     FontSize="14" Foreground="#A8D8FF"
                     HorizontalAlignment="Center" TextAlignment="Center"
                     TextWrapping="Wrap" MaxWidth="320"
                     Margin="0,0,0,18"
                     FontFamily="Segoe UI Emoji, Segoe UI"/>
          <Border Height="3" CornerRadius="2" Background="#0D1423">
            <ProgressBar Height="3" IsIndeterminate="True"
                         Background="Transparent" BorderThickness="0">
              <ProgressBar.Foreground>
                <LinearGradientBrush StartPoint="0,0" EndPoint="1,0">
                  <GradientStop Color="#22D3EE" Offset="0"/>
                  <GradientStop Color="#818CF8" Offset="1"/>
                </LinearGradientBrush>
              </ProgressBar.Foreground>
            </ProgressBar>
          </Border>
        </StackPanel>

        <!-- done -->
        <StackPanel x:Name="PanelDone" Visibility="Collapsed"
                    HorizontalAlignment="Center">
          <TextBlock Text="&#x2713;  Pronto! O IDV Tracker j&#x00E1; est&#x00E1; rodando." FontSize="13" Foreground="#4ADE80"
                     HorizontalAlignment="Center" Margin="0,0,0,28"
                     TextAlignment="Center" TextWrapping="Wrap" MaxWidth="300"
                     FontFamily="Segoe UI"/>
          <Button x:Name="BtnOk" Content="OK"
                  Width="160" Height="44" Cursor="Hand" BorderThickness="0"
                  FontFamily="Segoe UI" FontSize="14" FontWeight="SemiBold">
            <Button.Background>
              <LinearGradientBrush StartPoint="0,0" EndPoint="1,0">
                <GradientStop Color="#22D3EE" Offset="0"/>
                <GradientStop Color="#818CF8" Offset="1"/>
              </LinearGradientBrush>
            </Button.Background>
            <Button.Foreground>
              <SolidColorBrush Color="#0A0C14"/>
            </Button.Foreground>
            <Button.Template>
              <ControlTemplate TargetType="Button">
                <Border Background="{TemplateBinding Background}" CornerRadius="10">
                  <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
                </Border>
              </ControlTemplate>
            </Button.Template>
          </Button>
        </StackPanel>

        <!-- error -->
        <StackPanel x:Name="PanelError" Visibility="Collapsed"
                    HorizontalAlignment="Center">
          <TextBlock x:Name="TxtError" FontSize="12" Foreground="#F87171"
                     HorizontalAlignment="Center" TextWrapping="Wrap"
                     Margin="0,0,0,24" FontFamily="Segoe UI"
                     MaxWidth="260" TextAlignment="Center"/>
          <Button x:Name="BtnError" Content="Fechar"
                  Width="160" Height="44" Cursor="Hand" BorderThickness="0"
                  Background="#161E30" Foreground="#64748B"
                  FontFamily="Segoe UI" FontSize="14" FontWeight="SemiBold">
            <Button.Template>
              <ControlTemplate TargetType="Button">
                <Border Background="{TemplateBinding Background}" CornerRadius="10">
                  <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
                </Border>
              </ControlTemplate>
            </Button.Template>
          </Button>
        </StackPanel>

      </StackPanel>
    </Grid>
  </Border>
</Window>
'@

try {
    $reader = New-Object System.Xml.XmlNodeReader $XAML
    $window = [Windows.Markup.XamlReader]::Load($reader)
} catch {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show("Erro ao carregar janela:`n$($_.Exception.Message)", "IDV Tracker - Erro", "OK", "Error")
    exit 1
}

$BtnClose        = $window.FindName("BtnClose")
$ImgIcon         = $window.FindName("ImgIcon")
$PanelInstalling = $window.FindName("PanelInstalling")
$PanelDone       = $window.FindName("PanelDone")
$PanelError      = $window.FindName("PanelError")
$BtnOk           = $window.FindName("BtnOk")
$BtnError        = $window.FindName("BtnError")
$TxtError        = $window.FindName("TxtError")
$TxtInstallStatus = $window.FindName("TxtInstallStatus")

# Icon
if ($IconPath -and (Test-Path $IconPath)) {
    $bmp = New-Object Windows.Media.Imaging.BitmapImage
    $bmp.BeginInit()
    $bmp.UriSource   = New-Object System.Uri($IconPath)
    $bmp.CacheOption = [Windows.Media.Imaging.BitmapCacheOption]::OnLoad
    $bmp.EndInit()
    $ImgIcon.Source = $bmp
    $window.Icon    = $bmp
}

# Drag / close
$window.Add_MouseLeftButtonDown({ $window.DragMove() })
$BtnClose.Add_Click({ if ($sync.InstallFinished) { $window.Close() } })

$emojiInstall = [char]::ConvertFromUtf32(0x1F6E0)
$emojiRank = [char]::ConvertFromUtf32(0x1F4C9)
$emojiKeyboard = [char]::ConvertFromUtf32(0x2328)
$emojiSecret = [char]::ConvertFromUtf32(0x1F92B)
$installMessages = @(
    "$emojiInstall Instalando o IDV Tracker",
    "$emojiRank Verificando se o Hug$([char]0x00E3)o j$([char]0x00E1) dropou de elo hj...",
    "$emojiKeyboard Tentando concertar o teclado quebrado do Ar3s...",
    "$emojiSecret Ajustando benga pro lume mamar no sigilo..."
)
$messageIndex = 0
$messageTimer = New-Object Windows.Threading.DispatcherTimer
$messageTimer.Interval = [TimeSpan]::FromMilliseconds(2200)
$messageTimer.Add_Tick({
    $script:messageIndex = ($script:messageIndex + 1) % $installMessages.Count
    $TxtInstallStatus.Text = $installMessages[$script:messageIndex]
})
$messageTimer.Start()

# Cross-thread sync
$sync = [hashtable]::Synchronized(@{
    TargetDir       = $TargetDir
    SupaUrl         = $SupaUrl
    SupaKey         = $SupaKey
    StartupVbs      = $StartupVbs
    SetupLog        = $SetupLog
    Dispatcher      = $window.Dispatcher
    PanelInstalling = $PanelInstalling
    PanelDone       = $PanelDone
    PanelError      = $PanelError
    TxtError        = $TxtError
    StatusTimer     = $messageTimer
    InstallFinished = $false
})

# Background install
$rs = [System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspace()
$rs.ApartmentState = "STA"
$rs.ThreadOptions  = "ReuseThread"
$rs.Open()
$rs.SessionStateProxy.SetVariable("sync", $sync)

$ps = [System.Management.Automation.PowerShell]::Create()
$ps.Runspace = $rs
[void]$ps.AddScript({
    $dir  = $sync.TargetDir
    $url  = $sync.SupaUrl
    $key  = $sync.SupaKey
    $vbs  = $sync.StartupVbs
    $setupLog = $sync.SetupLog
    $d    = $sync.Dispatcher

    function Ui([scriptblock]$sb) { $d.Invoke([System.Action]$sb) }

    Start-Sleep -Milliseconds 600  # mostra o estado "instalando" brevemente

    try {
        # npm install
        $installLog = Join-Path $dir "install.log"
        "IDV Tracker npm install" | Set-Content -Path $installLog -Encoding UTF8
        "dir: $dir" | Add-Content -Path $installLog -Encoding UTF8
        "path: $env:PATH" | Add-Content -Path $installLog -Encoding UTF8
        "node: $(& node.exe -v 2>&1)" | Add-Content -Path $installLog -Encoding UTF8
        "npm: $(& npm.cmd -v 2>&1)" | Add-Content -Path $installLog -Encoding UTF8
        "" | Add-Content -Path $installLog -Encoding UTF8

        function LogStep([string]$text) {
            $stamp = Get-Date -Format "dd/MM/yyyy HH:mm:ss"
            $line = "[$stamp] $text"
            Add-Content -Path $installLog -Value $line -Encoding UTF8
            if ($setupLog) {
                try { Add-Content -Path $setupLog -Value "[installer] $text" -Encoding UTF8 } catch {}
            }
        }

        LogStep "Iniciando npm install"
        Push-Location $dir
        try {
            & npm.cmd install --no-audit --no-fund *>> $installLog
            $exitCode = $LASTEXITCODE
        } finally {
            Pop-Location
        }

        LogStep "npm install terminou com codigo $exitCode"
        if ($exitCode -ne 0) {
            $tail = ""
            if (Test-Path $installLog) {
                $tail = (Get-Content -Path $installLog -Tail 12) -join "`n"
            }
            throw "Falha ao instalar pacotes (npm). Log: $installLog`n$tail"
        }

        # .env
        $envPath = Join-Path $dir ".env"
        Set-Content -Path $envPath `
            -Value "SUPABASE_URL=$url`r`nSUPABASE_ANON_KEY=$key" -Encoding UTF8
        LogStep ".env atualizado"

        # startup VBS (iniciar com o Windows)
        $bat = [System.IO.Path]::GetFullPath((Join-Path $dir "..\IDV-Tracker.bat"))
        if (-not (Test-Path $bat)) {
            throw "Launcher nao encontrado: $bat"
        }

        $startupDir = Split-Path -Parent $vbs
        if (-not (Test-Path $startupDir)) {
            New-Item -ItemType Directory -Path $startupDir -Force | Out-Null
        }
        $vbsText  = "Set o = CreateObject(`"WScript.Shell`")`r`n"
        $vbsText += "o.Run Chr(34) & `"$bat`" & Chr(34), 0, False"
        Set-Content -Path $vbs -Value $vbsText -Encoding ASCII
        LogStep "Startup configurado: $vbs"

        # marca como instalado
        $installedMarker = Join-Path $dir ".installed"
        New-Item -ItemType File -Path $installedMarker -Force | Out-Null
        if (-not (Test-Path -LiteralPath $installedMarker)) {
            throw "Marcador de instalacao nao foi criado: $installedMarker"
        }
        LogStep "Marcador .installed criado"

        # inicia o agent imediatamente apos instalar
        $running = Get-CimInstance Win32_Process | Where-Object {
            $_.CommandLine -and
            $_.CommandLine.Contains($dir) -and
            ($_.Name -eq "node.exe" -or $_.Name -eq "cmd.exe" -or $_.Name -eq "npm.cmd")
        }
        if ($running) {
            LogStep "Agent ja estava rodando"
        } else {
            $shell = New-Object -ComObject WScript.Shell
            [void]$shell.Run("`"$bat`" --run", 0, $false)
            LogStep "Agent iniciado via launcher --run"
        }

        Ui {
            $sync.InstallFinished = $true
            $sync.StatusTimer.Stop()
            $sync.PanelInstalling.Visibility = [System.Windows.Visibility]::Collapsed
            $sync.PanelDone.Visibility       = [System.Windows.Visibility]::Visible
        }
    }
    catch {
        $msg = $_.Exception.Message
        if ($setupLog) {
            try {
                Add-Content -Path $setupLog -Value "[installer] ERRO: $msg" -Encoding UTF8
            } catch {}
        }
        Ui {
            $sync.InstallFinished = $true
            $sync.StatusTimer.Stop()
            $sync.PanelInstalling.Visibility = [System.Windows.Visibility]::Collapsed
            $sync.TxtError.Text              = $msg
            $sync.PanelError.Visibility      = [System.Windows.Visibility]::Visible
        }
    }
})
[void]$ps.BeginInvoke()

# Buttons
$BtnOk.Add_Click({
    $window.Close()
})
$BtnError.Add_Click({ $window.Close() })

$app = New-Object System.Windows.Application
$app.Add_Exit({
    $ps.Stop()
    $rs.Close()
    if ($InstallerMutex) {
        try { $InstallerMutex.ReleaseMutex() } catch {}
        $InstallerMutex.Dispose()
    }
})
[void]$app.Run($window)
