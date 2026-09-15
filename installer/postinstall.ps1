# מורץ אוטומטית ע"י המתקין (setup.exe), כ-Administrator, בסוף ההתקנה.
# מבצע: שירות Windows, הקשחה, כתיבת טוקן המכשיר לסנכרון עם הענן, והורדת
# הרשאות מחשבון הילד. Node.js כבר ארוז בתוך ההתקנה עצמה (runtime\) — אין
# כאן שום תלות ברשת/winget/npm registry של המחשב הזה בכלל; הסנכרון בפועל
# עם הענן (Cloudflare Worker) קורה מאוחר יותר, כשהשירות רץ, לא כאן. כל שלב
# עטוף בטיפול שגיאות משלו כדי ששגיאה אחת לא תעצור את כל השאר — בסוף מודפס
# סיכום של מה שכן ומה שלא הושלם.

[CmdletBinding()]
param(
    [string]$ChildUsername = '',

    [Parameter(Mandatory = $true)]
    [string]$DeviceToken
)

$ErrorActionPreference = 'Stop'
$InstallerDir = $PSScriptRoot
$AppDir = Split-Path -Parent $InstallerDir
$LogFile = Join-Path $AppDir 'install.log'
$RuntimeDir = Join-Path $AppDir 'runtime'
$NodeExe = Join-Path $RuntimeDir 'node.exe'
$script:Failures = @()

function Write-Log {
    param([string]$Message, [string]$Level = 'INFO')
    $line = "[{0}] [{1}] {2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    Write-Host $line
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

function Invoke-Step {
    param(
        [string]$Name,
        [scriptblock]$Action,
        [bool]$Critical = $false
    )
    Write-Log "=== $Name ==="
    try {
        & $Action
        Write-Log "הושלם: $Name"
    } catch {
        Write-Log "נכשל: $Name -- $($_.Exception.Message)" 'ERROR'
        $script:Failures += $Name
        if ($Critical) { throw }
    }
}

# מריץ תוכנית חיצונית ורושם את הפלט שלה ליומן. חייב לעטוף כל קריאה כזו:
# תוכניות חיצוניות רבות כותבות שורות מידע רגילות ל-stderr, ו-PowerShell עם
# $ErrorActionPreference='Stop' הופך כל שורת stderr שעוברת דרך 2>&1 לשגיאה
# עוצרת — גם כשהתוכנית בעצם הצליחה. לכן מבטלים את ErrorActionPreference
# זמנית סביב הקריאה, ובודקים הצלחה/כישלון אמיתיים רק לפי קוד היציאה בפועל.
function Invoke-NativeLogged {
    param(
        [Parameter(Mandatory = $true)][string]$Prefix,
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @()
    )
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $FilePath @Arguments 2>&1 | ForEach-Object { Write-Log "$Prefix`: $_" }
    } finally {
        $ErrorActionPreference = $prevEAP
    }
    if ($LASTEXITCODE -ne 0) {
        throw "$Prefix נכשל (קוד יציאה $LASTEXITCODE)"
    }
}

Write-Log "התחלת התקנה. תיקיית אפליקציה: $AppDir"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $isAdmin) {
    Write-Log "הסקריפט חייב לרוץ כ-Administrator." 'ERROR'
    exit 1
}

if (-not (Test-Path $NodeExe)) {
    Write-Log "לא נמצא $NodeExe — קובץ ההתקנה כנראה פגום או לא הושלם. הורידו מחדש את המתקין והריצו שוב." 'ERROR'
    exit 1
}
# runtime\ מכיל node.exe + npm.cmd + npx.cmd — שמים אותו ראשון ב-PATH כדי
# שקריאות "node"/"npm" ישתמשו בגרסה הארוזה, לא בגרסה כלשהי שמותקנת (או לא)
# על המחשב הזה.
$env:Path = "$RuntimeDir;$env:Path"
Write-Log "Node.js ארוז בהתקנה: $(& $NodeExe -v)"

# --- שלב 1: שירות Windows ---
Invoke-Step -Name 'התקנת שירות Windows (KidsNetControl)' -Critical $true -Action {
    $svc = Get-Service -Name 'KidsNetControl' -ErrorAction SilentlyContinue
    if ($svc) {
        Write-Log "שירות קיים כבר מותקן — מסיר לפני התקנה מחדש (עדכון גרסה)."
        Stop-Service -Name 'KidsNetControl' -Force -ErrorAction SilentlyContinue
        & $NodeExe (Join-Path $AppDir 'install\service-uninstall.js')
        $deadline = (Get-Date).AddSeconds(30)
        while ((Get-Service -Name 'KidsNetControl' -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
            Start-Sleep -Seconds 2
        }
    }
    & $NodeExe (Join-Path $AppDir 'install\service-install.js')
    Start-Sleep -Seconds 3
    $svc = Get-Service -Name 'KidsNetControl' -ErrorAction SilentlyContinue
    if (-not $svc -or $svc.Status -ne 'Running') {
        throw "השירות לא במצב Running אחרי ההתקנה (סטטוס: $($svc.Status))."
    }
    Write-Log "השירות רץ."
}

# --- שלב 2: הקשחה ---
Invoke-Step -Name 'הקשחה נגד עקיפה (DNS/Chrome/Firewall/הרשאות)' -Critical $false -Action {
    Invoke-NativeLogged -Prefix 'harden' -FilePath 'powershell.exe' -Arguments @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $AppDir 'install\harden.ps1')
    )
}

# --- שלב 3: טוקן מכשיר לסנכרון עם הענן ---
Invoke-Step -Name 'כתיבת טוקן מכשיר' -Critical $true -Action {
    $tokenPath = Join-Path $AppDir 'data\device-token'
    New-Item -ItemType Directory -Force -Path (Join-Path $AppDir 'data') | Out-Null
    Set-Content -Path $tokenPath -Value $DeviceToken.Trim() -Encoding ASCII -NoNewline
    Write-Log "טוקן המכשיר נכתב ל-$tokenPath. השירות יתחיל להסתנכרן עם הענן בהפעלה הבאה שלו."
    # אם השירות כבר רץ (למשל עדכון), מפעילים אותו מחדש כדי שיקרא את הטוקן
    # החדש מיידית, בלי לחכות לאיתחול המחשב.
    Restart-Service -Name 'KidsNetControl' -ErrorAction SilentlyContinue
}

# --- שלב 4: הורדת הרשאות מחשבון הילד (אופציונלי) ---
if ([string]::IsNullOrWhiteSpace($ChildUsername)) {
    Write-Log "לא הוזן שם חשבון ילד — מדלגים על הורדת הרשאות Administrator (התבקש במפורש)."
} else {
    Invoke-Step -Name 'הורדת הרשאות Administrator מחשבון הילד' -Critical $false -Action {
        $childUser = Get-LocalUser -Name $ChildUsername -ErrorAction SilentlyContinue
        if (-not $childUser) {
            throw "חשבון בשם '$ChildUsername' לא נמצא במחשב הזה. בדקו את שם החשבון המדויק (Get-LocalUser) והורידו הרשאות ידנית דרך הגדרות Windows."
        }
        $admins = Get-LocalGroupMember -Group 'Administrators'
        $isChildAdmin = $admins | Where-Object { $_.Name -eq $ChildUsername -or $_.Name -like "*\$ChildUsername" }
        if (-not $isChildAdmin) {
            Write-Log "חשבון '$ChildUsername' כבר אינו ברשימת ה-Administrators — אין צורך בפעולה."
            return
        }
        $otherAdmins = $admins | Where-Object { $_.Name -ne $ChildUsername -and $_.Name -notlike "*\$ChildUsername" }
        if (-not $otherAdmins -or $otherAdmins.Count -eq 0) {
            throw "לא נמצא חשבון Administrator אחר מלבד '$ChildUsername' — לא מורידים הרשאות כדי לא לנעול את המחשב. ודאו שיש חשבון הורה כ-Administrator ואז הריצו את ההתקנה שוב."
        }
        Remove-LocalGroupMember -Group 'Administrators' -Member $ChildUsername
        Write-Log "חשבון '$ChildUsername' הוסר מקבוצת Administrators. חשבונות Administrator שנשארו: $(($otherAdmins.Name) -join ', ')"
    }
}

# --- סיכום ---
Write-Log "=== סיכום התקנה ==="
if ($script:Failures.Count -eq 0) {
    Write-Log "כל השלבים הושלמו בהצלחה."
    Write-Host ""
    Write-Host "ההתקנה הושלמה בהצלחה. עמוד המצב המקומי זמין ב-http://localhost:8080" -ForegroundColor Green
} else {
    Write-Log "השלבים הבאים לא הושלמו ודורשים בדיקה ידנית: $($script:Failures -join '; ')" 'WARN'
    Write-Host ""
    Write-Host "ההתקנה הסתיימה עם בעיות בשלבים הבאים:" -ForegroundColor Yellow
    $script:Failures | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
    Write-Host "פרטים מלאים ביומן: $LogFile" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "יומן מלא: $LogFile"
Read-Host "הקישו Enter כדי לסגור חלון זה"
