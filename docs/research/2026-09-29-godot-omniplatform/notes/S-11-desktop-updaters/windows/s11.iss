; S-11: a per-user Inno Setup installer for the WinSparkle arm (research code).
; iscc /DAppVer=1.0.0 /DSrcDir=..\out\ws-1.0.0 /DOutDir=..\out\installers s11.iss
[Setup]
AppId={{6B0C3F38-2C55-4A1B-9E57-5A11C0DE0011}
AppName=S11WinSparkle
AppVersion={#AppVer}
AppPublisher=PolarisKeyS11
DefaultDirName={localappdata}\S11WinSparkle
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir={#OutDir}
OutputBaseFilename=S11WinSparkle-{#AppVer}-setup
Compression=lzma2/fast
CloseApplications=force
RestartApplications=no
UninstallDisplayName=S11WinSparkle

[Files]
Source: "{#SrcDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs

[Run]
Filename: "{app}\s11game.exe"; Flags: nowait postinstall skipifnotsilent
