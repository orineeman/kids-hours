# מורץ אוטומטית ע"י המתקין (setup.exe), כ-Administrator, בסוף ההתקנה.
# מבצע את כל השלבים שבעבר בוצעו ידנית לפי WINDOWS_DEPLOY.md: שירות
# Windows, הקשחה, Cloudflare Tunnel (אופציונלי), והורדת הרשאות מחשבון
# הילד. Node.js ו-cloudflared כבר ארוזים בתוך ההתקנה עצמה (runtime\) —
# אין כאן שום תלות ברשת/winget/npm registry של המחשב הזה, מלבד שלב
# Cloudflare עצמו שמטבעו דורש התחברות מקוונת. כל שלב עטוף בטיפול שגיאות
# משלו כדי ששגיאה אחת לא תעצור את כל השאר — בסוף מודפס סיכום של מה שכן
# ומה שלא הושלם.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ChildUsername,

    [switch]$SetupCloudflare,

    [string]$CloudflareDomain = "musagim-bamaharal.org",
    [string]$CloudflareSubdomain = "kids",
    [string]$TunnelName = "kids-control"
)

$ErrorActionPreference = 'Stop'
$InstallerDir = $PSScriptRoot
$AppDir = Split-Path -Parent $InstallerDir
$LogFile = Join-Path $AppDir 'install.log'
$RuntimeDir = Join-Path $AppDir 'runtime'
$NodeExe = Join-Path $RuntimeDir 'node.exe'
$CloudflaredExe = Join-Path $RuntimeDir 'cloudflared.exe'
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
# runtime\ מכיל node.exe + npm.cmd + npx.cmd + cloudflared.exe — שמים אותו
# ראשון ב-PATH כדי שקריאות "node"/"npm"/"cloudflared" ישתמשו בגרסה הארוזה,
# לא בגרסה כלשהי שמותקנת (או לא) על המחשב הזה.
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
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $AppDir 'install\harden.ps1') 2>&1 |
        ForEach-Object { Write-Log "harden: $_" }
    if ($LASTEXITCODE -ne 0) {
        throw "harden.ps1 הסתיים עם קוד שגיאה $LASTEXITCODE"
    }
}

# --- שלב 3: Cloudflare Tunnel (אופציונלי) ---
if ($SetupCloudflare) {
    Invoke-Step -Name 'הגדרת גישה מרחוק (Cloudflare Tunnel)' -Critical $false -Action {
        if (-not (Test-Path $CloudflaredExe)) {
            throw "cloudflared.exe לא נמצא בתיקיית ההתקנה ($CloudflaredExe) — קובץ ההתקנה כנראה פגום."
        }

        $cfDir = Join-Path $env:USERPROFILE '.cloudflared'
        $certFile = Join-Path $cfDir 'cert.pem'
        if (-not (Test-Path $certFile)) {
            Write-Log "פותח דפדפן להתחברות לחשבון Cloudflare — יש להשלים את ההתחברות שם עכשיו (חד-פעמי)."
            Start-Process -FilePath $CloudflaredExe -ArgumentList 'tunnel login' -Wait -NoNewWindow
        }
        if (-not (Test-Path $certFile)) {
            throw "ההתחברות ל-Cloudflare לא הושלמה (לא נמצא cert.pem). אפשר להריץ שוב את ההתקנה אחרי התחברות ידנית עם: cloudflared tunnel login"
        }

        $existingId = $null
        $tunnelListOutput = & $CloudflaredExe tunnel list 2>&1
        foreach ($line in $tunnelListOutput) {
            if ($line -match "^\s*([0-9a-fA-F-]{36})\s+$([regex]::Escape($TunnelName))\s") {
                $existingId = $matches[1]
            }
        }
        if (-not $existingId) {
            Write-Log "יוצר טאנל חדש בשם '$TunnelName'..."
            & $CloudflaredExe tunnel create $TunnelName 2>&1 | ForEach-Object { Write-Log "cloudflared: $_" }
        } else {
            Write-Log "טאנל '$TunnelName' כבר קיים (ID $existingId) — משתמש בו מחדש."
        }

        $credFile = Get-ChildItem -Path $cfDir -Filter '*.json' -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if (-not $credFile) {
            throw "לא נמצא קובץ credentials של הטאנל בתיקייה $cfDir"
        }

        $fullHostname = "$CloudflareSubdomain.$CloudflareDomain"
        & $CloudflaredExe tunnel route dns $TunnelName $fullHostname 2>&1 | ForEach-Object { Write-Log "cloudflared: $_" }

        $configYml = @"
tunnel: $TunnelName
credentials-file: $($credFile.FullName)
ingress:
  - hostname: $fullHostname
    service: http://localhost:8080
  - service: http_status:404
"@
        Set-Content -Path (Join-Path $cfDir 'config.yml') -Value $configYml -Encoding UTF8
        Write-Log "config.yml נכתב עבור hostname $fullHostname"

        $cfSvc = Get-Service -Name 'cloudflared' -ErrorAction SilentlyContinue
        if ($cfSvc) {
            & $CloudflaredExe service uninstall 2>&1 | ForEach-Object { Write-Log "cloudflared: $_" }
            Start-Sleep -Seconds 2
        }
        & $CloudflaredExe service install 2>&1 | ForEach-Object { Write-Log "cloudflared: $_" }
        Start-Sleep -Seconds 3
        $cfSvc = Get-Service -Name 'cloudflared' -ErrorAction SilentlyContinue
        if (-not $cfSvc -or $cfSvc.Status -ne 'Running') {
            throw "שירות cloudflared לא במצב Running אחרי ההתקנה."
        }
        Write-Log "לוח הבקרה יהיה זמין מרחוק בכתובת https://$fullHostname (עשוי לקחת כמה דקות להפצת DNS)."
    }
}

# --- שלב 4: הורדת הרשאות מחשבון הילד ---
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

# --- סיכום ---
Write-Log "=== סיכום התקנה ==="
if ($script:Failures.Count -eq 0) {
    Write-Log "כל השלבים הושלמו בהצלחה."
    Write-Host ""
    Write-Host "ההתקנה הושלמה בהצלחה. לוח הבקרה זמין ב-http://localhost:8080" -ForegroundColor Green
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
