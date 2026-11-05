' QuizZy Windowless VBScript Launcher
' Launches keep_backend_alive.ps1 completely invisible (window style 0, zero taskbar flash)

Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
psScript = fso.BuildPath(scriptDir, "keep_backend_alive.ps1")

If Not fso.FileExists(psScript) Then
    parentDir = fso.GetParentFolderName(scriptDir)
    psScript = fso.BuildPath(parentDir, "scripts\keep_backend_alive.ps1")
End If

cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & psScript & """"
WshShell.Run cmd, 0, False

Set WshShell = Nothing
Set fso = Nothing
