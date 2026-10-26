; ReelHeist v0.3.0 Inno Setup Installer
#define MyAppName "ReelHeist"
#define MyAppVersion "0.3.0"
#define MyAppPublisher "ReelHeist"
#define MyAppURL "https://github.com/ergulburak/reelheist"

[Setup]
AppId={{9A3E5F41-4A1E-4D62-9F88-7E4E5B880100}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}/releases
DefaultDirName={localappdata}\ReelHeist\app
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
LicenseFile=..\LICENSE
OutputDir=Output
OutputBaseFilename=ReelHeist-Setup-{#MyAppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName={#MyAppName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "turkish"; MessagesFile: "compiler:Languages\Turkish.isl"
Name: "spanish"; MessagesFile: "compiler:Languages\Spanish.isl"
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"
Name: "french"; MessagesFile: "compiler:Languages\French.isl"
Name: "german"; MessagesFile: "compiler:Languages\German.isl"
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"
Name: "arabic"; MessagesFile: "compiler:Languages\Arabic.isl"
Name: "chinesesimplified"; MessagesFile: "languages\ChineseSimplified.isl"
Name: "indonesian"; MessagesFile: "languages\Indonesian.isl"
Name: "japanese"; MessagesFile: "compiler:Languages\Japanese.isl"
Name: "hindi"; MessagesFile: "languages\Hindi.isl"

[Files]
Source: "..\dist\app\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Registry]
Root: HKCU; Subkey: "Software\Google\Chrome\NativeMessagingHosts\com.reelheist.helper"; ValueType: string; ValueName: ""; ValueData: "{localappdata}\ReelHeist\com.reelheist.helper.json"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.reelheist.helper"; ValueType: string; ValueName: ""; ValueData: "{localappdata}\ReelHeist\com.reelheist.helper.json"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Microsoft\Edge\NativeMessagingHosts\com.reelheist.helper"; ValueType: string; ValueName: ""; ValueData: "{localappdata}\ReelHeist\com.reelheist.helper.json"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Chromium\NativeMessagingHosts\com.reelheist.helper"; ValueType: string; ValueName: ""; ValueData: "{localappdata}\ReelHeist\com.reelheist.helper.json"; Flags: uninsdeletekey

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

#include "download.iss"
