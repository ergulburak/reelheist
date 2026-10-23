[Code]
var
  BraveCheck: TNewCheckBox;
  ChromeCheck: TNewCheckBox;
  EdgeCheck: TNewCheckBox;
  BraveExe: String;
  ChromeExe: String;
  EdgeExe: String;

function FindBrowserExe(AppPathKey: String; Fallback1: String; Fallback2: String): String;
var
  S: String;
begin
  Result := '';
  if RegQueryStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\App Paths\' + AppPathKey, '', S) and FileExists(S) then
  begin
    Result := S;
    Exit;
  end;
  if RegQueryStringValue(HKLM, 'Software\Microsoft\Windows\CurrentVersion\App Paths\' + AppPathKey, '', S) and FileExists(S) then
  begin
    Result := S;
    Exit;
  end;
  if (Fallback1 <> '') and FileExists(Fallback1) then
  begin
    Result := Fallback1;
    Exit;
  end;
  if (Fallback2 <> '') and FileExists(Fallback2) then
  begin
    Result := Fallback2;
    Exit;
  end;
end;

procedure InitializeWizard;
var
  TopY: Integer;
begin
  BraveExe := FindBrowserExe(
    'brave.exe',
    ExpandConstant('{localappdata}\BraveSoftware\Brave-Browser\Application\brave.exe'),
    ExpandConstant('{autopf}\BraveSoftware\Brave-Browser\Application\brave.exe')
  );
  ChromeExe := FindBrowserExe(
    'chrome.exe',
    ExpandConstant('{localappdata}\Google\Chrome\Application\chrome.exe'),
    ExpandConstant('{autopf}\Google\Chrome\Application\chrome.exe')
  );
  EdgeExe := FindBrowserExe(
    'msedge.exe',
    ExpandConstant('{autopf}\Microsoft\Edge\Application\msedge.exe'),
    ''
  );

  TopY := WizardForm.FinishedLabel.Top + WizardForm.FinishedLabel.Height + ScaleY(12);

  if BraveExe <> '' then
  begin
    BraveCheck := TNewCheckBox.Create(WizardForm);
    BraveCheck.Parent := WizardForm.FinishedPage;
    BraveCheck.Left := WizardForm.FinishedLabel.Left;
    BraveCheck.Top := TopY;
    BraveCheck.Width := WizardForm.FinishedLabel.Width;
    BraveCheck.Caption := 'Brave — Add extension (open setup guide)';
    BraveCheck.Checked := True;
    TopY := TopY + ScaleY(24);
  end;

  if ChromeExe <> '' then
  begin
    ChromeCheck := TNewCheckBox.Create(WizardForm);
    ChromeCheck.Parent := WizardForm.FinishedPage;
    ChromeCheck.Left := WizardForm.FinishedLabel.Left;
    ChromeCheck.Top := TopY;
    ChromeCheck.Width := WizardForm.FinishedLabel.Width;
    ChromeCheck.Caption := 'Google Chrome — Add extension (open setup guide)';
    ChromeCheck.Checked := (BraveExe = '');
    TopY := TopY + ScaleY(24);
  end;

  if EdgeExe <> '' then
  begin
    EdgeCheck := TNewCheckBox.Create(WizardForm);
    EdgeCheck.Parent := WizardForm.FinishedPage;
    EdgeCheck.Left := WizardForm.FinishedLabel.Left;
    EdgeCheck.Top := TopY;
    EdgeCheck.Width := WizardForm.FinishedLabel.Width;
    EdgeCheck.Caption := 'Microsoft Edge — Add extension (open setup guide)';
    EdgeCheck.Checked := (BraveExe = '') and (ChromeExe = '');
    TopY := TopY + ScaleY(24);
  end;
end;

function ReadGuideUrl(): String;
var
  Lines: TArrayOfString;
  I: Integer;
  UrlFile: String;
begin
  Result := 'http://127.0.0.1:47861/';
  UrlFile := ExpandConstant('{app}\guide.url');
  if FileExists(UrlFile) and LoadStringsFromFile(UrlFile, Lines) then
  begin
    for I := 0 to GetArrayLength(Lines) - 1 do
    begin
      if Pos('URL=', Lines[I]) = 1 then
      begin
        Result := Copy(Lines[I], 5, Length(Lines[I]) - 4);
        Exit;
      end;
    end;
  end;
end;

procedure RemoveLegacyRegistryKeys();
begin
  RegDeleteKeyIncludingSubkeys(HKCU, 'Software\Google\Chrome\NativeMessagingHosts\com.dizi_indirici.helper');
  RegDeleteKeyIncludingSubkeys(HKCU, 'Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.dizi_indirici.helper');
  RegDeleteKeyIncludingSubkeys(HKCU, 'Software\Microsoft\Edge\NativeMessagingHosts\com.dizi_indirici.helper');
  RegDeleteKeyIncludingSubkeys(HKCU, 'Software\Chromium\NativeMessagingHosts\com.dizi_indirici.helper');
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  NodeExe: String;
  TaskScript: String;
  AppDir: String;
  GuideUrl: String;
begin
  if CurStep = ssPostInstall then
  begin
    RemoveLegacyRegistryKeys();
    WizardForm.StatusLabel.Caption := 'Configuring ReelHeist helper, ffmpeg, and yt-dlp...';
    AppDir := ExpandConstant('{app}');
    NodeExe := ExpandConstant('{app}\node\node.exe');
    TaskScript := ExpandConstant('{app}\helper\installer-tasks.js');
    Exec(NodeExe, '"' + TaskScript + '" install "' + AppDir + '"', AppDir, SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end
  else if (CurStep = ssDone) and (not WizardSilent()) then
  begin
    GuideUrl := ReadGuideUrl();
    if (BraveCheck <> nil) and BraveCheck.Checked and (BraveExe <> '') then
      Exec(BraveExe, GuideUrl, '', SW_SHOWNORMAL, ewNoWait, ResultCode);
    if (ChromeCheck <> nil) and ChromeCheck.Checked and (ChromeExe <> '') then
      Exec(ChromeExe, GuideUrl, '', SW_SHOWNORMAL, ewNoWait, ResultCode);
    if (EdgeCheck <> nil) and EdgeCheck.Checked and (EdgeExe <> '') then
      Exec(EdgeExe, GuideUrl, '', SW_SHOWNORMAL, ewNoWait, ResultCode);
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ResultCode: Integer;
  NodeExe: String;
  TaskScript: String;
begin
  if CurUninstallStep = usUninstall then
  begin
    NodeExe := ExpandConstant('{app}\node\node.exe');
    TaskScript := ExpandConstant('{app}\helper\installer-tasks.js');
    if FileExists(NodeExe) and FileExists(TaskScript) then
      Exec(NodeExe, '"' + TaskScript + '" shutdown', ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end
  else if CurUninstallStep = usPostUninstall then
  begin
    DelTree(ExpandConstant('{localappdata}\ReelHeist'), True, True, True);
  end;
end;
