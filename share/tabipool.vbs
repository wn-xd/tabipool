' tabipool.vbs - launch the supervisor with no console window.
'
' Why: a console-attached cmd.exe receives Ctrl-C / console-close events from whatever
' session spawned it and dies with 0xC000013A, killing the restart loop with it.
' WScript.Shell.Run with windowStyle 0 gives the child no console to be signalled on.
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = scriptDir
' 0 = hidden/no window, False = return immediately
shell.Run "cmd.exe /c """ & scriptDir & "\start.cmd""", 0, False
