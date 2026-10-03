; A per-user Inno Setup installer for a Godot Windows export updated by WinSparkle (P5-07; from
; notes/S-11's s11.iss). The end-to-end run compiles it; a game copies and adapts it.
;
;   iscc /DAppName=Game /DAppVer=1.0.0 /DAppExe=game.exe /DSrcDir=out\ws-1.0.0 /DOutDir=out\installers game.iss
;
; The release's build `format` must be `inno` so the Worker's WinSparkle appcast carries
; sparkle:installerArguments="/SILENT /SP- /NOICONS"; WinSparkle then runs the installer silently
; after asking the game to quit. CloseApplications=force closes a straggler; the [Run] entry
; starts the new build after a silent install.
#ifndef AppId
  #define AppId "{{6B0C3F38-2C55-4A1B-9E57-5A11C0DE0011}"
#endif
[Setup]
AppId={#AppId}
AppName={#AppName}
AppVersion={#AppVer}
AppPublisher=Polaris Key
DefaultDirName={localappdata}\{#AppName}
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir={#OutDir}
OutputBaseFilename={#AppName}-{#AppVer}-setup
Compression=lzma2/fast
CloseApplications=force
RestartApplications=no
UninstallDisplayName={#AppName}

[Files]
Source: "{#SrcDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs

[Run]
Filename: "{app}\{#AppExe}"; Flags: nowait postinstall skipifnotsilent
