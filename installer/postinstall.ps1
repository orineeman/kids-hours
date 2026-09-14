# מורץ אוטומטית ע"י המתקין (setup.exe), כ-Administrator, בסוף ההתקנה.
# מבצע את כל השלבים שבעבר בוצעו ידנית לפי WINDOWS_DEPLOY.md: תלויות,
# שירות Windows, הקשחה, Cloudflare Tunnel (אופציונלי), והורדת הרשאות
# מחשבון הילד. כל שלב עטוף בטיפול שגיאות משלו כדי ששגיאה אחת לא תעצור
# את כל השאר — בסוף מודפס סיכום של מה שכן ומה שלא הושלם.

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

function Refresh-EnvPath {
    $machine = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [System.Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user"
}

Write-Log "התחלת התקנה. תיקיית אפליקציה: $AppDir"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $isAdmin) {
    Write-Log "הסקריפט חייב לרוץ כ-Administrator." 'ERROR'
    exit 1
}

# --- שלב 1: Node.js ---
Invoke-Step -Name 'בדיקת/התקנת Node.js' -Critical $true -Action {
    $existing = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Log "Node.js כבר מותקן: $(& node.exe -v)"
        return
    }
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if (-not $winget) {
        throw "Node.js לא מותקן ו-winget לא זמין במערכת. יש להתקין Node.js 18+ ידנית (https://nodejs.org) ואז להריץ את ההתקנה הזו שוב."
    }
    Write-Log "מתקין Node.js LTS דרך winget..."
    & winget install --id OpenJS.NodeJS.LTS -e --source winget --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        Write-Log "winget install (Node.js) החזיר קוד שגיאה $LASTEXITCODE — בודק בכל זאת אם Node.js הותקן." 'WARN'
    }
    Start-Sleep -Seconds 5
    Refresh-EnvPath
    if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
        $fallback = Join-Path $env:ProgramFiles 'nodejs'
        if (Test-Path (Join-Path $fallback 'node.exe')) {
            $env:Path = "$fallback;$env:Path"
        }
    }
    if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
        throw "התקנת Node.js ע'י winget נכשלה או ש-node.exe עדיין לא נמצא ב-PATH (קוד יציאה של winget: $LASTEXITCODE). אם winget מתלונן על מקור msstore — נסו להריץ ידנית: winget install --id OpenJS.NodeJS.LTS -e --source winget . אפשר גם להתקין Node.js 18+ ידנית מ-https://nodejs.org ואז להריץ את ההתקנה הזו שוב."
    }
    Write-Log "Node.js הותקן: $(& node.exe -v)"
}

# --- שלב 2: npm install ---
Invoke-Step -Name 'התקנת חבילות npm' -Critical $true -Action {
    Push-Location $AppDir
    try {
        $npmOutput = & npm.cmd install --omit=dev --no-fund --no-audit 2>&1
        $npmOutput | ForEach-Object { Write-Log "npm: $_" }
        if ($LASTEXITCODE -ne 0) {
            $outputText = $npmOutput -join "`n"
            if ($outputText -match 'SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_') {
                # קורה כשתוכנת אנטי-וירוס/VPN מיירטת חיבורי HTTPS (סריקת SSL) ומחליפה
                # את אישור npm באישור משלה, ששובר את אימות האישורים. עוקפים זמנית.
                Write-Log "נראה שתוכנת אנטי-וירוס/VPN על המחשב הזה מיירטת חיבורי HTTPS ושוברת את אימות האישורים של npm. מנסה לעקוף זמנית..." 'WARN'
                & npm.cmd config set strict-ssl false
                $retryOutput = & npm.cmd install --omit=dev --no-fund --no-audit 2>&1
                $retryOutput | ForEach-Object { Write-Log "npm(retry): $_" }
                $retryExitCode = $LASTEXITCODE
                & npm.cmd config set strict-ssl true
                if ($retryExitCode -ne 0) {
                    throw "npm install נכשל גם אחרי עקיפת בדיקת האישורים. כנראה תוכנת אנטי-וירוס/VPN חוסמת את החיבור לגמרי — כבו זמנית את 'סריקת HTTPS' / 'SSL scan' שלה ונסו להריץ את ההתקנה שוב."
                }
                Write-Log "npm install הצליח אחרי עקיפה זמנית של בדיקת האישורים (strict-ssl הוחזר למצב מאובטח)."
                return
            }
            throw "npm install נכשל (exit code $LASTEXITCODE). אם מדובר בשגיאת קומפילציה של better-sqlite3, ייתכן שנדרשים Visual Studio Build Tools."
        }
    } finally {
        Pop-Location
    }
}

# --- שלב 3: שירות Windows ---
Invoke-Step -Name 'התקנת שירות Windows (KidsNetControl)' -Critical $true -Action {
    $svc = Get-Service -Name 'KidsNetControl' -ErrorAction SilentlyContinue
    if ($svc) {
        Write-Log "שירות קיים כבר מותקן — מסיר לפני התקנה מחדש (עדכון גרסה)."
        Stop-Service -Name 'KidsNetControl' -Force -ErrorAction SilentlyContinue
        & node.exe (Join-Path $AppDir 'install\service-uninstall.js')
        $deadline = (Get-Date).AddSeconds(30)
        while ((Get-Service -Name 'KidsNetControl' -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
            Start-Sleep -Seconds 2
        }
    }
    & node.exe (Join-Path $AppDir 'install\service-install.js')
    Start-Sleep -Seconds 3
    $svc = Get-Service -Name 'KidsNetControl' -ErrorAction SilentlyContinue
    if (-not $svc -or $svc.Status -ne 'Running') {
        throw "השירות לא במצב Running אחרי ההתקנה (סטטוס: $($svc.Status))."
    }
    Write-Log "השירות רץ."
}

# --- שלב 4: הקשחה ---
Invoke-Step -Name 'הקשחה נגד עקיפה (DNS/Chrome/Firewall/הרשאות)' -Critical $false -Action {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $AppDir 'install\harden.ps1') 2>&1 |
        ForEach-Object { Write-Log "harden: $_" }
    if ($LASTEXITCODE -ne 0) {
        throw "harden.ps1 הסתיים עם קוד שגיאה $LASTEXITCODE"
    }
}

# --- שלב 5: Cloudflare Tunnel (אופציונלי) ---
if ($SetupCloudflare) {
    Invoke-Step -Name 'הגדרת גישה מרחוק (Cloudflare Tunnel)' -Critical $false -Action {
        $cf = Get-Command cloudflared.exe -ErrorAction SilentlyContinue
        if (-not $cf) {
            $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
            if (-not $winget) { throw "cloudflared לא מותקן ו-winget לא זמין." }
            Write-Log "מתקין cloudflared..."
            & winget install --id Cloudflare.cloudflared -e --source winget --silent --accept-package-agreements --accept-source-agreements
            if ($LASTEXITCODE -ne 0) {
                Write-Log "winget install (cloudflared) החזיר קוד שגיאה $LASTEXITCODE — בודק בכל זאת אם cloudflared הותקן." 'WARN'
            }
            Start-Sleep -Seconds 5
            Refresh-EnvPath
        }
        if (-not (Get-Command cloudflared.exe -ErrorAction SilentlyContinue)) {
            throw "cloudflared לא נמצא לאחר ניסיון ההתקנה."
        }

        $cfDir = Join-Path $env:USERPROFILE '.cloudflared'
        $certFile = Join-Path $cfDir 'cert.pem'
        if (-not (Test-Path $certFile)) {
            Write-Log "פותח דפדפן להתחברות לחשבון Cloudflare — יש להשלים את ההתחברות שם עכשיו (חד-פעמי)."
            Start-Process -FilePath 'cloudflared.exe' -ArgumentList 'tunnel login' -Wait -NoNewWindow
        }
        if (-not (Test-Path $certFile)) {
            throw "ההתחברות ל-Cloudflare לא הושלמה (לא נמצא cert.pem). אפשר להריץ שוב את ההתקנה אחרי התחברות ידנית עם: cloudflared tunnel login"
        }

        $existingId = $null
        $tunnelListOutput = & cloudflared.exe tunnel list 2>&1
        foreach ($line in $tunnelListOutput) {
            if ($line -match "^\s*([0-9a-fA-F-]{36})\s+$([regex]::Escape($TunnelName))\s") {
                $existingId = $matches[1]
            }
        }
        if (-not $existingId) {
            Write-Log "יוצר טאנל חדש בשם '$TunnelName'..."
            & cloudflared.exe tunnel create $TunnelName 2>&1 | ForEach-Object { Write-Log "cloudflared: $_" }
        } else {
            Write-Log "טאנל '$TunnelName' כבר קיים (ID $existingId) — משתמש בו מחדש."
        }

        $credFile = Get-ChildItem -Path $cfDir -Filter '*.json' -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if (-not $credFile) {
            throw "לא נמצא קובץ credentials של הטאנל בתיקייה $cfDir"
        }

        $fullHostname = "$CloudflareSubdomain.$CloudflareDomain"
        & cloudflared.exe tunnel route dns $TunnelName $fullHostname 2>&1 | ForEach-Object { Write-Log "cloudflared: $_" }

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
            & cloudflared.exe service uninstall 2>&1 | ForEach-Object { Write-Log "cloudflared: $_" }
            Start-Sleep -Seconds 2
        }
        & cloudflared.exe service install 2>&1 | ForEach-Object { Write-Log "cloudflared: $_" }
        Start-Sleep -Seconds 3
        $cfSvc = Get-Service -Name 'cloudflared' -ErrorAction SilentlyContinue
        if (-not $cfSvc -or $cfSvc.Status -ne 'Running') {
            throw "שירות cloudflared לא במצב Running אחרי ההתקנה."
        }
        Write-Log "לוח הבקרה יהיה זמין מרחוק בכתובת https://$fullHostname (עשוי לקחת כמה דקות להפצת DNS)."
    }
}

# --- שלב 6: הורדת הרשאות מחשבון הילד ---
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
