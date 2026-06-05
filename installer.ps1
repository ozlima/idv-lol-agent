$TargetDir = $env:IDV_TARGET_DIR
$IconPath  = $env:IDV_ICON_PATH
$SupaUrl   = $env:SUPABASE_URL
$SupaKey   = $env:SUPABASE_ANON_KEY
$StartupVbs = [System.IO.Path]::Combine(
    $env:APPDATA,
    "Microsoft\Windows\Start Menu\Programs\Startup\IDV-LoL-Agent.vbs"
)

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

[xml]$XAML = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="IDV Tracker" Width="400" Height="480"
        WindowStartupLocation="CenterScreen"
        ResizeMode="NoResize" WindowStyle="None"
        AllowsTransparency="True" Background="Transparent"
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
                  Width="300" Margin="0,-16,0,0">

        <!-- icon with cyan glow -->
        <Border HorizontalAlignment="Center" Margin="0,0,0,24">
          <Border.Effect>
            <DropShadowEffect Color="#22D3EE" BlurRadius="28"
                              ShadowDepth="0" Opacity="0.45"/>
          </Border.Effect>
          <Image x:Name="ImgIcon" Height="88" Width="88"
                 RenderOptions.BitmapScalingMode="HighQuality"/>
        </Border>

        <!-- title -->
        <TextBlock Text="IDV Tracker"
                   FontSize="26" FontWeight="Bold" Foreground="#E2E8F0"
                   HorizontalAlignment="Center" Margin="0,0,0,6"
                   FontFamily="Segoe UI"/>

        <!-- tagline -->
        <TextBlock Text="MONITOR DE PARTIDAS"
                   FontSize="10" Foreground="#1C2E4A"
                   HorizontalAlignment="Center" Margin="0,0,0,44"
                   FontFamily="Segoe UI"/>

        <!-- installing -->
        <StackPanel x:Name="PanelInstalling">
          <TextBlock Text="Instalando IDV Tracker"
                     FontSize="12" Foreground="#33496A"
                     HorizontalAlignment="Center" Margin="0,0,0,16"
                     FontFamily="Segoe UI"/>
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
          <TextBlock Text="&#x2713;  Pronto!" FontSize="13" Foreground="#4ADE80"
                     HorizontalAlignment="Center" Margin="0,0,0,28"
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

# ── Icon ──────────────────────────────────────────────────────────────────────
if ($IconPath -and (Test-Path $IconPath)) {
    $bmp = New-Object Windows.Media.Imaging.BitmapImage
    $bmp.BeginInit()
    $bmp.UriSource   = New-Object System.Uri($IconPath)
    $bmp.CacheOption = [Windows.Media.Imaging.BitmapCacheOption]::OnLoad
    $bmp.EndInit()
    $ImgIcon.Source = $bmp
    $window.Icon    = $bmp
}

# ── Drag / close ──────────────────────────────────────────────────────────────
$window.Add_MouseLeftButtonDown({ $window.DragMove() })
$BtnClose.Add_Click({ $window.Close() })

# ── Cross-thread sync ─────────────────────────────────────────────────────────
$sync = [hashtable]::Synchronized(@{
    TargetDir       = $TargetDir
    SupaUrl         = $SupaUrl
    SupaKey         = $SupaKey
    StartupVbs      = $StartupVbs
    Dispatcher      = $window.Dispatcher
    PanelInstalling = $PanelInstalling
    PanelDone       = $PanelDone
    PanelError      = $PanelError
    TxtError        = $TxtError
})

# ── Background install ────────────────────────────────────────────────────────
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
    $d    = $sync.Dispatcher

    function Ui([scriptblock]$sb) { $d.BeginInvoke([Action]$sb) | Out-Null }

    Start-Sleep -Milliseconds 600  # mostra o estado "instalando" brevemente

    try {
        # npm install
        if (-not (Test-Path (Join-Path $dir "node_modules"))) {
            $r = Start-Process "cmd" -ArgumentList "/c npm install --silent" `
                 -WorkingDirectory $dir -Wait -PassThru -NoNewWindow
            if ($r.ExitCode -ne 0) { throw "Falha ao instalar pacotes (npm)." }
        }

        # .env
        Set-Content -Path (Join-Path $dir ".env") `
            -Value "SUPABASE_URL=$url`r`nSUPABASE_ANON_KEY=$key" -Encoding UTF8

        # startup VBS (iniciar com o Windows)
        if (-not (Test-Path $vbs)) {
            $bat = [System.IO.Path]::GetFullPath((Join-Path $dir "..\IDV-LoL-Agent.bat"))
            if (Test-Path $bat) {
                $vbsText  = "Set o = CreateObject(`"WScript.Shell`")`r`n"
                $vbsText += "o.Run Chr(34) & `"$bat`" & Chr(34), 1, False"
                Set-Content -Path $vbs -Value $vbsText -Encoding ASCII
            }
        }

        # marca como instalado
        Set-Content -Path (Join-Path $dir ".installed") -Value "" -Encoding ASCII

        Ui {
            $sync.PanelInstalling.Visibility = [System.Windows.Visibility]::Collapsed
            $sync.PanelDone.Visibility       = [System.Windows.Visibility]::Visible
        }
    }
    catch {
        $msg = $_.Exception.Message
        Ui {
            $sync.PanelInstalling.Visibility = [System.Windows.Visibility]::Collapsed
            $sync.TxtError.Text              = $msg
            $sync.PanelError.Visibility      = [System.Windows.Visibility]::Visible
        }
    }
})
[void]$ps.BeginInvoke()

# ── Buttons ───────────────────────────────────────────────────────────────────
$BtnOk.Add_Click({
    Start-Process "cmd" -ArgumentList "/c cd /d `"$TargetDir`" && npm run dev" `
        -WindowStyle Minimized
    $window.Close()
})
$BtnError.Add_Click({ $window.Close() })

[void]$window.ShowDialog()
$ps.Stop()
$rs.Close()
