# הרצה כ-Administrator בלבד, על מחשב הילדים:
#   powershell -ExecutionPolicy Bypass -File install\harden.ps1
#
# מבצע את כל שכבות ההקשחה נגד עקיפה שמתוארות בתוכנית:
#   1. הגדרת DNS של המחשב ל-127.0.0.1 (השרת המקומי שלנו)
#   2. כיבוי Chrome Secure DNS (DoH) וחסימת התקנת תוספים, דרך מדיניות Registry
#   3. חסימת פורט 53 (DNS) יוצא לכל כתובת חוץ מלולבק (מונע מעבר DNS-שרת אחר)
#   4. חסימת גישה ל-IP-ים ידועים של ספקי DoH ציבוריים (הגנה כפולה על סעיף 2)
#
# הרצה בטוחה חוזרת (idempotent) — אפשר להריץ שוב בלי נזק.

#Requires -RunAsAdministrator

Write-Host "== 1. הגדרת DNS מקומי (127.0.0.1) על כל כרטיסי הרשת הפעילים ==" -ForegroundColor Cyan
Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | ForEach-Object {
    Set-DnsClientServerAddress -InterfaceIndex $_.ifIndex -ServerAddresses ("127.0.0.1")
    Write-Host "  $($_.Name): DNS -> 127.0.0.1"
}

Write-Host "== 2. מדיניות Chrome: כיבוי Secure DNS + חסימת תוספים ==" -ForegroundColor Cyan
$chromePolicyPath = "HKLM:\SOFTWARE\Policies\Google\Chrome"
New-Item -Path $chromePolicyPath -Force | Out-Null
Set-ItemProperty -Path $chromePolicyPath -Name "DnsOverHttpsMode" -Value "off" -Type String

$extBlockPath = "HKLM:\SOFTWARE\Policies\Google\Chrome\ExtensionInstallBlocklist"
New-Item -Path $extBlockPath -Force | Out-Null
Set-ItemProperty -Path $extBlockPath -Name "1" -Value "*" -Type String
Write-Host "  DnsOverHttpsMode=off, ExtensionInstallBlocklist=* הוגדרו."

Write-Host "== 3. חסימת DNS יוצא (פורט 53) לכל כתובת חוץ מ-127.0.0.0/8 ==" -ForegroundColor Cyan
$externalRanges = @("0.0.0.0-126.255.255.255", "128.0.0.0-255.255.255.255")
Remove-NetFirewallRule -DisplayName "KidsNetControl-Block-External-DNS-UDP" -ErrorAction SilentlyContinue
Remove-NetFirewallRule -DisplayName "KidsNetControl-Block-External-DNS-TCP" -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName "KidsNetControl-Block-External-DNS-UDP" `
    -Direction Outbound -Protocol UDP -RemotePort 53 -Action Block `
    -RemoteAddress $externalRanges | Out-Null
New-NetFirewallRule -DisplayName "KidsNetControl-Block-External-DNS-TCP" `
    -Direction Outbound -Protocol TCP -RemotePort 53 -Action Block `
    -RemoteAddress $externalRanges | Out-Null
Write-Host "  חוקי חסימה נוצרו."

Write-Host "== 4. חסימת IP-ים ידועים של ספקי DoH ציבוריים (הגנה כפולה) ==" -ForegroundColor Cyan
$dohIps = @("1.1.1.1", "1.0.0.1", "8.8.8.8", "8.8.4.4", "9.9.9.9", "149.112.112.112")
Remove-NetFirewallRule -DisplayName "KidsNetControl-Block-DoH-IPs" -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName "KidsNetControl-Block-DoH-IPs" `
    -Direction Outbound -Protocol TCP -RemotePort 443 -Action Block `
    -RemoteAddress $dohIps | Out-Null
Write-Host "  נחסמו: $($dohIps -join ', ')"

Write-Host "== 5. נעילת הרשאות על תיקיית ההתקנה (מונע עריכת ה-DB ע'י המשתמש הרגיל) ==" -ForegroundColor Cyan
$installPath = (Resolve-Path "$PSScriptRoot\..").Path
icacls $installPath /inheritance:r | Out-Null
icacls $installPath /grant:r "SYSTEM:(OI)(CI)F" | Out-Null
icacls $installPath /grant:r "BUILTIN\Administrators:(OI)(CI)F" | Out-Null
icacls $installPath /grant:r "BUILTIN\Users:(OI)(CI)RX" | Out-Null
Write-Host "  $installPath : SYSTEM/Administrators=מלא, Users=קריאה בלבד"

Write-Host ""
Write-Host "הקשחה הושלמה. חשוב לוודא בנוסף:" -ForegroundColor Yellow
Write-Host "  - חשבון הילד מוגדר כ-Standard User (לא Administrator)."
Write-Host "  - השירות (KidsNetControl) מותקן ורץ — ראה install\service-install.js"
