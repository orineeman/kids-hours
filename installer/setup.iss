; מתקין Windows עבור מערכת בקרת האינטרנט לילדים (KidsNetControl).
; מקומפל אוטומטית ע"י GitHub Actions (.github/workflows/build-installer.yml)
; על ריצת Windows, כי אין כאן מחשב Windows לקמפל עליו מקומית.
;
; ה-workflow מוריד Node.js (runtime\), מריץ npm install (node_modules\),
; ומוריד cloudflared.exe (runtime\) *לפני* הקומפילציה — כל זה נארז בתוך
; ה-.exe. כך שההתקנה בפועל על מחשב הילדים לא נוגעת באינטרנט בכלל (חוץ
; משלב Cloudflare Tunnel האופציונלי, שמטבעו דורש התחברות מקוונת) ולא
; תלויה ב-winget/npm registry/אנטי-וירוס של אותו מחשב.
;
; מריץ, כ-Administrator: מעתיק את הקבצים, ואז מריץ installer\postinstall.ps1
; שמבצע את כל שאר ההתקנה (שירות, הקשחה, Cloudflare, הורדת הרשאות מחשבון
; הילד) — ראה postinstall.ps1 לפרטים.

#define MyAppName "בקרת אינטרנט לילדים"
#define MyAppVersion "1.1.0"
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
Source: "..\public\*"; DestDir: "{app}\public"; Flags: recursesubdirs createallsubdirs ignoreversion
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
Name: "{group}\לוח הבקרה"; Filename: "{app}\dashboard.url"
Name: "{group}\הסרת ההתקנה"; Filename: "{uninstallexe}"

[Run]
Filename: "powershell.exe"; \
    Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\installer\postinstall.ps1"" -ChildUsername ""{code:GetChildUsername}"" {code:GetCloudflareFlag}"; \
    WorkingDir: "{app}"; \
    StatusMsg: "מריץ את שלבי ההתקנה (זה יכול לקחת כמה דקות — כולל התחברות ל-Cloudflare אם נבחר)..."; \
    Flags: waituntilterminated

[UninstallRun]
Filename: "powershell.exe"; \
    Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\installer\uninstall.ps1"""; \
    WorkingDir: "{app}"; \
    Flags: waituntilterminated

[Code]
var
  ChildAccountPage: TInputQueryWizardPage;
  CloudflarePage: TInputOptionWizardPage;

procedure InitializeWizard;
begin
  ChildAccountPage := CreateInputQueryPage(wpSelectDir,
    'חשבון הילד', 'איזה חשבון משתמש בוינדוס שייך לילד?',
    'הזינו את שם המשתמש המדויק של חשבון הילד (בדיוק כפי שמופיע בהגדרות Windows). ' +
    'ההתקנה תוריד ממנו הרשאות Administrator בסוף התהליך, כדי שההגנות לא יהיו ' +
    'ניתנות לעקיפה. חשבון ההורה (שממנו מריצים את ההתקנה) יישאר Administrator.');
  ChildAccountPage.Add('שם משתמש של חשבון הילד:', False);

  CloudflarePage := CreateInputOptionPage(ChildAccountPage.ID,
    'גישה מרחוק ללוח הבקרה', 'הגדרת Cloudflare Tunnel (אופציונלי)',
    'זה מאפשר להורה להיכנס ללוח הבקרה מכל מקום, לא רק מהבית. התהליך יפתח ' +
    'דפדפן וידרוש התחברות חד-פעמית לחשבון Cloudflare — יש להשלים אותה כשהיא ' +
    'נפתחת. אם לא בטוחים, אפשר לדלג ולהגדיר בהמשך ידנית (ראה README).',
    False, False);
  CloudflarePage.Add('הגדר עכשיו גישה מרחוק (Cloudflare Tunnel)');
  CloudflarePage.Values[0] := True;
end;

function GetChildUsername(Param: string): string;
begin
  Result := ChildAccountPage.Values[0];
end;

function GetCloudflareFlag(Param: string): string;
begin
  if CloudflarePage.Values[0] then
    Result := '-SetupCloudflare'
  else
    Result := '';
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = ChildAccountPage.ID then
  begin
    if Trim(ChildAccountPage.Values[0]) = '' then
    begin
      MsgBox('יש להזין שם משתמש של חשבון הילד לפני שממשיכים.', mbError, MB_OK);
      Result := False;
    end;
  end;
end;
