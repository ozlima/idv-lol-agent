#define AppName "IDV Tracker"
#define AppVersion "1.0.3"

[Setup]
AppId={{8C0C9361-6BB6-4C7D-9D2A-9834B38C8D1F}}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=IDV
CreateAppDir=no
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
DisableFinishedPage=yes
OutputDir=dist
OutputBaseFilename=IDV-Tracker-Setup
SetupIconFile=IDV-Tracker-Setup.ico
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64
PrivilegesRequired=lowest
Uninstallable=no
CloseApplications=no
ShowLanguageDialog=no

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Files]
Source: "IDV-Tracker-Setup.cmd"; DestDir: "{tmp}"; Flags: deleteafterinstall
Source: "IDV-Tracker-Setup.ico"; DestDir: "{tmp}"; Flags: deleteafterinstall

[Run]
Filename: "{cmd}"; Parameters: "/d /c ""{tmp}\IDV-Tracker-Setup.cmd"" --inner"; Flags: runhidden waituntilterminated
