; מתקין Windows עבור מערכת בקרת האינטרנט לילדים (KidsNetControl).
; מקומפל אוטומטית ע"י GitHub Actions (.github/workflows/build-installer.yml)
; על ריצת Windows, כי אין כאן מחשב Windows לקמפל עליו מקומית.
;
; ה-workflow מוריד Node.js (runtime\) ומריץ npm install (node_modules\)
; *לפני* הקומפילציה — כל זה נארז בתוך ה-.exe. כך שההתקנה בפועל על מחשב
; הילדים לא נוגעת באינטרנט בכלל, ולא תלויה ב-winget/npm registry/
; אנטי-וירוס של אותו מחשב. גישה מרחוק ללוח הבקרה עוברת דרך Cloudflare
; Worker (ראה cloud/README.md) — אין יותר תלות ב-cloudflared/Tunnel כאן.
;
; מריץ, כ-Administrator: מעתיק את הקבצים, ואז מריץ installer\postinstall.ps1
; שמבצע את כל שאר ההתקנה (שירות, הקשחה, הורדת הרשאות מחשבון הילד) — ראה
; postinstall.ps1 לפרטים.

#define MyAppName "בקרת אינטרנט לילדים"
#define MyAppVersion "2.0.0"
#define MyAppPublisher "Ori Neeman"
#define MyServiceName "KidsNetControl"

[Setup]
AppId={{83C1C311-7A5F-4AF0-973A-3F2EA5B20818}}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\KidsNetControl
DefaultGroupName=KidsNetControl
DisableProgramGroupPage=yes
DisableWelcomePage=no
PrivilegesRequired=admin
OutputDir=dist
OutputBaseFilename=KidsNetControl-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#MyAppName}
ArchitecturesInstallIn64BitMode=x64compatible

[Files]
Source: "..\src\*"; DestDir: "{app}\src"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "..\install\*"; DestDir: "{app}\install"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "..\node_modules\*"; DestDir: "{app}\node_modules"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "runtime\*"; DestDir: "{app}\runtime"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "..\package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\package-lock.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "postinstall.ps1"; DestDir: "{app}\installer"; Flags: ignoreversion
Source: "uninstall.ps1"; DestDir: "{app}\installer"; Flags: ignoreversion
Source: "dashboard.url"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\מצב מקומי"; Filename: "{app}\dashboard.url"
Name: "{group}\הסרת ההתקנה"; Filename: "{uninstallexe}"

[Run]
Filename: "powershell.exe"; \
    Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\installer\postinstall.ps1"" -ChildUsername ""{code:GetChildUsername}"" -DeviceToken ""{code:GetDeviceToken}"""; \
    WorkingDir: "{app}"; \
    StatusMsg: "מריץ את שלבי ההתקנה (זה יכול לקחת כמה דקות)..."; \
    Flags: waituntilterminated

[UninstallRun]
Filename: "powershell.exe"; \
    Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\installer\uninstall.ps1"""; \
    WorkingDir: "{app}"; \
    Flags: waituntilterminated

[Code]
var
  ChildAccountPage: TInputQueryWizardPage;
  DeviceTokenPage: TInputQueryWizardPage;

procedure InitializeWizard;
begin
  ChildAccountPage := CreateInputQueryPage(wpSelectDir,
    'חשבון הילד', 'איזה חשבון משתמש בוינדוס שייך לילד?',
    'הזינו את שם המשתמש המדויק של חשבון הילד (בדיוק כפי שמופיע בהגדרות Windows). ' +
    'ההתקנה תוריד ממנו הרשאות Administrator בסוף התהליך, כדי שההגנות לא יהיו ' +
    'ניתנות לעקיפה. חשבון ההורה (שממנו מריצים את ההתקנה) יישאר Administrator. ' +
    'ניתן להשאיר ריק אם אין חשבון הורה נפרד במחשב הזה — במקרה כזה שלב זה ידלג ' +
    'באופן בטוח.');
  ChildAccountPage.Add('שם משתמש של חשבון הילד (אפשר להשאיר ריק):', False);

  DeviceTokenPage := CreateInputQueryPage(ChildAccountPage.ID,
    'חיבור לענן', 'הדבקת טוקן המכשיר',
    'המחשב הזה צריך טוקן ייחודי כדי להסתנכרן עם לוח הבקרה בענן (הענקת/ביטול ' +
    'גישה, רשימת אתרים). הטוקן נוצר פעם אחת ע"י מי שהקים את חלק הענן (ראה ' +
    'cloud/README.md, ' + '"npm run device:create"), ומודפס פעם אחת בלבד — ' +
    'הדביקו אותו כאן.');
  DeviceTokenPage.Add('Device Token:', False);
end;

function GetChildUsername(Param: string): string;
begin
  Result := ChildAccountPage.Values[0];
end;

function GetDeviceToken(Param: string): string;
begin
  Result := DeviceTokenPage.Values[0];
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = DeviceTokenPage.ID then
  begin
    if Trim(DeviceTokenPage.Values[0]) = '' then
    begin
      MsgBox('יש להדביק את טוקן המכשיר לפני שממשיכים — בלעדיו המחשב לא יכול ' +
        'להסתנכרן עם לוח הבקרה בענן.', mbError, MB_OK);
      Result := False;
    end;
  end;
end;
