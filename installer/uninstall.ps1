# מורץ אוטומטית ע"י תהליך ההסרה (Uninstall), כ-Administrator, לפני שהקבצים
# נמחקים. מנקה את השירות, ה-DNS, ה-Firewall, ומדיניות Chrome. לא משחזר
# הרשאות Administrator לחשבון הילד באופן אוטומטי (החלטת בטיחות מכוונת).

$ErrorActionPreference = 'Continue'
$InstallerDir = $PSScriptRoot
$AppDir = Split-Path -Parent $InstallerDir
$NodeExe = Join-Path $AppDir 'runtime\node.exe'

Write-Host "== מסיר שירות KidsNetControl ==" -ForegroundColor Cyan
try {
    Stop-Service -Name 'KidsNetControl' -Force -ErrorAction SilentlyContinue
    & $NodeExe (Join-Path $AppDir 'install\service-uninstall.js')
    Start-Sleep -Seconds 3
} catch {
    Write-Host "שגיאה בהסרת השירות: $($_.Exception.Message)" -ForegroundColor Yellow
}

Write-Host "== מחזיר DNS להגדרת ברירת מחדל (DHCP) ==" -ForegroundColor Cyan
try {
    Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | ForEach-Object {
        Set-DnsClientServerAddress -InterfaceIndex $_.ifIndex -ResetServerAddresses
        Write-Host "  $($_.Name): DNS אופס ל-DHCP"
    }
} catch {
    Write-Host "שגיאה באיפוס DNS: $($_.Exception.Message)" -ForegroundColor Yellow
}

Write-Host "== מסיר חוקי Firewall ==" -ForegroundColor Cyan
Remove-NetFirewallRule -DisplayName "KidsNetControl-*" -ErrorAction SilentlyContinue

Write-Host "== מסיר מדיניות Chrome (Secure DNS / חסימת תוספים) ==" -ForegroundColor Cyan
Remove-Item -Path "HKLM:\SOFTWARE\Policies\Google\Chrome\ExtensionInstallBlocklist" -Recurse -Force -ErrorAction SilentlyContinue
Remove-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Google\Chrome" -Name "DnsOverHttpsMode" -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "הסרה הושלמה." -ForegroundColor Green
Write-Host "שימו לב: הרשאות ה-Administrator של חשבון הילד (אם הוסרו בהתקנה) לא שוחזרו אוטומטית מטעמי בטיחות — יש לעשות זאת ידנית דרך הגדרות Windows אם רוצים." -ForegroundColor Yellow
Read-Host "הקישו Enter לסגירה"
