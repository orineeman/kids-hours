# הוראות פריסה — מיושן (ראו README.md)

> **המסמך הזה מיושן ולא בשימוש.** הפריסה הידנית שהוא מתאר הוחלפה פעמיים:
> ראשית ע"י מתקין Windows (`installer/`, ראו README.md), ואז ע"י המעבר
> לארכיטקטורת ענן (`cloud/`) — שמבטל גם את הצורך ב-Cloudflare Tunnel שהמסמך
> מתאר. נשאר כאן להפניה היסטורית בלבד; אל תעקבו אחריו להתקנה בפועל.

# הוראות פריסה — למי שמריץ את זה בפועל (Claude, על מחשב הילדים)

מסמך זה מיועד לסוכן (Claude) שמריץ את שלבי הפריסה בפועל, על מחשב Windows
פיזי, בליווי ההורה שנמצא שם. תעקוב אחרי השלבים **לפי הסדר**, תריץ כל פקודה,
תוודא את התוצאה הצפויה לפני שממשיכים לשלב הבא, ואל תנחש כשמשהו לא ברור —
תעצור ותשאל את ההורה (ראה "מתי לעצור ולשאול" בסוף המסמך).

## הקשר: מה בונים ולמה

זו מערכת בקרת הורים. **כל אתר שמוגדר ברשימה חסום כברירת מחדל** במחשב הילדים.
כשהילד מבקש גישה (לוואטסאפ ווב, או לאתר אחר שבהמשך יתווסף), ההורה נכנס ללוח
בקרה בדפדפן (מהמחשב הזה, או מרחוק מכל מקום דרך `https://kids.musagim-bamaharal.org`)
ולוחץ "פתח ל-X דקות" — האתר נפתח לזמן שהוגדר ונחסם אוטומטית מחדש בסופו.

הקוד כבר כתוב ונבדק (על מחשב אחר, לא Windows) — התפקיד שלך כאן הוא רק
**להתקין ולהקשיח** אותו על מחשב הילדים בפועל. שום שינוי בקוד לא אמור להידרש.

**חשוב להבין לפני שמתחילים:** חלק מהשלבים כאן משנים הגדרות רשת ואבטחה
ברמת המערכת (DNS, Firewall, Registry, הרשאות משתמש) על מחשב אמיתי שאנשים
משתמשים בו. זו לא סביבת פיתוח חד-פעמית — טעות כאן יכולה לנתק את המחשב
מהאינטרנט או לנעול מישהו מחוץ לחשבון שלו. פעל בזהירות, ותעד כל שינוי לפני
שאתה מבצע אותו כדי שאפשר יהיה לשחזר.

## גיבוי מצב קיים (לפני כל שינוי)

הרץ ושמור את הפלט (למשל לקובץ בשולחן העבודה) לפני שמתחילים:
```powershell
Get-DnsClientServerAddress -AddressFamily IPv4 | Out-File $env:USERPROFILE\Desktop\backup-dns.txt
netsh advfirewall firewall show rule name=all | Out-File $env:USERPROFILE\Desktop\backup-firewall.txt
Get-LocalGroupMember -Group "Administrators" | Out-File $env:USERPROFILE\Desktop\backup-admins.txt
Copy-Item C:\Windows\System32\drivers\etc\hosts $env:USERPROFILE\Desktop\backup-hosts.txt
```

## שלב 0: בדיקות מוקדמות

1. ודא שאתה רץ בתור Administrator:
   ```powershell
   ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
   ```
   חייב להחזיר `True`. אם לא — עצור, פתח PowerShell מחדש "כמנהל" (Run as Administrator).

2. ודא ש-Node.js מותקן (גרסה 18 ומעלה):
   ```powershell
   node -v
   ```
   אם חסר — **שאל את ההורה** אם להתקין (`winget install OpenJS.NodeJS.LTS`), אל תתקין תוכנה חדשה על המחשב בלי אישור מפורש.

3. ודא שאין כבר משהו על פורט 53 (ה-DNS resolver שלנו צריך אותו):
   ```powershell
   Get-NetUDPEndpoint -LocalPort 53
   ```
   אם יש תוצאה (למשל שירות ICS — Internet Connection Sharing, או תוכנת אבטחה/VPN ארגוני) — **עצור ושאל את ההורה** לפני שממשיכים. אל תעצור שירות קיים בלי לדעת מה הוא.

4. זהה איזה חשבון משתמש הוא של הילד:
   ```powershell
   Get-LocalUser | Select-Object Name, Enabled
   ```
   **שאל את ההורה** איזה שם חשבון בדיוק שייך לילד, אל תנחש לפי שם החשבון בלבד.

## שלב 1: מיקום קבצי הפרויקט

ודא שתיקיית הפרויקט (`whatsapp-kids-hours`) כבר נמצאת על המחשב הזה (ההורה
היה אמור להעביר אותה — USB, ענן, git וכו'). אם אינה נמצאת — **שאל את ההורה**
איך להשיג אותה, אל תמשיך בלי הקוד בפועל.

לאחר שמצאת אותה:
```powershell
cd <נתיב-לתיקיית-הפרויקט>
```

## שלב 2: התקנת תלויות

```powershell
npm install
```
תוצאה צפויה: `added X packages` ו-`found 0 vulnerabilities` (או קרוב לזה).

**אם `better-sqlite3` נכשל בבנייה** (שגיאת קומפילציה, node-gyp) — זה כנראה
דורש Visual Studio Build Tools (C++ workload) שלא מותקנים. זו התקנה כבדה —
**עצור ושאל את ההורה** לפני שמתקינים כלי build נוספים.

## שלב 3: בדיקה ראשונית (לפני התקנה כשירות)

```powershell
node src\index.js
```
תוצאה צפויה בקונסולה:
```
[firewall:dry-run]...   <- לא אמור להופיע ב-Windows אמיתי; אם כן מופיע, בדוק שרצים כ-Administrator
Dashboard listening on http://127.0.0.1:8080
DNS resolver listening on :53
```
אם יש שגיאת `EADDRINUSE` על פורט 53 — חזור לבדיקה בשלב 0.3.

פתח דפדפן על אותו מחשב (או Remote Desktop) בכתובת `http://localhost:8080`:
- ייפתח ישר מסך כניסה (login) — **סיסמה בלבד, ללא שם משתמש** (חשבון הורה
  יחיד), עם סיסמת ברירת מחדל שנזרעת אוטומטית בהרצה הראשונה: `הרב דרוקמן`.
  **אל תגדיר סיסמה בעצמך** — זו כבר קיימת בקוד מראש.
- **חשוב — עצור ושאל את ההורה כאן**: זו סיסמת ברירת מחדל קבועה וידועה מראש
  (מופיעה גם בקוד המקור), בדיוק מה שהמערכת אמורה למנוע מהילד. יש להתחבר
  איתה פעם אחת ולהחליף אותה מיד: אין כרגע מסך "שינוי סיסמה" בלוח הבקרה, אז
  יש לעצור את השרת (Ctrl+C), למחוק את השורה הקיימת מהטבלה `parent_users`
  בקובץ `data\app.db` (למשל עם כלי `sqlite3`), ואז להריץ שוב את השרת ולגלוש
  ל-`/` — הפעם יופיע מסך "הגדרת חשבון הורה" הרגיל, ושם ההורה בוחר סיסמה
  משלו בלבד (אין שם משתמש, מינימום 8 תווים).
- לאחר ההגדרה, בטאב "יצירת דומיינים" ודא שברשימה מופיע "WhatsApp Web" במצב
  **חסום**. שים לב: לוח הבקרה מתנתק אוטומטית אחרי 5 דקות ללא פעילות.

עצור את התהליך (Ctrl+C) לפני המשך לשלב הבא, כדי לפנות את הפורטים.

## שלב 4: התקנה כשירות Windows

```powershell
node install\service-install.js
```
תוצאה צפויה: `Service "KidsNetControl" installed and started.`

וידוא:
```powershell
Get-Service KidsNetControl
```
`Status` צריך להיות `Running`.

## שלב 5: הקשחה נגד עקיפה

```powershell
powershell -ExecutionPolicy Bypass -File install\harden.ps1
```
עקוב אחרי הפלט — כל אחד מ-5 השלבים המודפסים אמור לעבור בלי שגיאה.

וידוא ידני אחרי ההרצה:
```powershell
Get-DnsClientServerAddress -AddressFamily IPv4      # אמור להראות 127.0.0.1
Get-ItemProperty "HKLM:\SOFTWARE\Policies\Google\Chrome" -Name DnsOverHttpsMode   # אמור להחזיר "off"
Get-NetFirewallRule -DisplayName "KidsNetControl-*"  # 3 חוקים חדשים
```

## שלב 6: הגדרת חשבון הילד כ-Standard User

**זהה קודם, מול ההורה, את שם החשבון המדויק** (שלב 0.4). לאחר אישור:
```powershell
Remove-LocalGroupMember -Group "Administrators" -Member "<שם-חשבון-הילד>"
```
וידוא:
```powershell
Get-LocalGroupMember -Group "Administrators"
```
ודא ששם חשבון הילד **לא** מופיע ברשימה, וש**נשאר לפחות חשבון Administrator אחד אחר** (חשבון ההורה) — אחרת אף אחד לא יוכל לנהל את המחשב יותר.

## שלב 7: חיבור Cloudflare Tunnel

הדומיין `musagim-bamaharal.org` כבר מנוהל ב-Cloudflare (פרויקט אחר של
ההורה) — כאן רק מוסיפים לו תת-דומיין חדש (`kids.musagim-bamaharal.org`),
בלי לגעת ברשומות הקיימות.

1. ודא ש-`cloudflared` מותקן (אם לא — הורד מ-Cloudflare, או `winget install Cloudflare.cloudflared`).
2. התחברות — **זה שלב אינטראקטיבי**: ייפתח דפדפן ועל **ההורה** להתחבר לחשבון ה-Cloudflare שלו ולאשר. חכה שההורה יאשר לפני שממשיכים:
   ```powershell
   cloudflared tunnel login
   ```
3. יצירת הטאנל וניתוב הדומיין:
   ```powershell
   cloudflared tunnel create kids-control
   cloudflared tunnel route dns kids-control kids.musagim-bamaharal.org
   ```
   שים לב לפלט של `tunnel create` — הוא מדפיס `Tunnel ID` ונתיב לקובץ credentials (למשל `C:\Users\<user>\.cloudflared\<TUNNEL_ID>.json`). תזדקק להם בשלב הבא.
4. צור קובץ תצורה `config.yml` (לרוב ב-`C:\Users\<user>\.cloudflared\config.yml`):
   ```yaml
   tunnel: kids-control
   credentials-file: C:\Users\<user>\.cloudflared\<TUNNEL_ID>.json
   ingress:
     - hostname: kids.musagim-bamaharal.org
       service: http://localhost:8080
     - service: http_status:404
   ```
   (החלף `<user>` ו-`<TUNNEL_ID>` בערכים האמיתיים מהפלט של שלב 3.)
5. התקנה כשירות:
   ```powershell
   cloudflared service install
   ```
6. וידוא: פתח מדפדפן **במחשב אחר** (לא מחשב הילדים) את `https://kids.musagim-bamaharal.org` — אמור להראות את מסך הכניסה של לוח הבקרה. אם לא נטען מיד, זה יכול לקחת כמה דקות (הפצת DNS) — בדוק עם:
   ```powershell
   nslookup kids.musagim-bamaharal.org
   ```

## שלב 8: בדיקות קבלה — לוודא שהכל באמת עובד

בצע את כולן, אל תדלג:

1. **Restart למחשב.** אחרי עלייה: `Get-Service KidsNetControl` → `Running`.
2. **מחשבון הילד**, נסה לשנות הגדרת DNS ידנית דרך הגדרות Windows → אמור לדרוש סיסמת Administrator / להיות חסום.
3. **בכרום, מחשבון הילד**, גלוש ל-`chrome://settings/security` → Secure DNS אמור להופיע ככבוי/מנוהל ע"י הארגון.
4. **בכרום, מחשבון הילד**, נסה להתקין תוסף מ-Chrome Web Store → אמור להיחסם עם הודעת מדיניות.
5. **מחשבון הילד**, נסה לגלוש ל-`web.whatsapp.com` → אמור להיכשל (לא נטען).
6. **מלוח הבקרה** (מקומי או דרך `https://kids.musagim-bamaharal.org`): תן ל-WhatsApp Web גרנט של 2-3 דקות. תוך כ-30 שניות (TTL של ה-DNS) הילד אמור להצליח לטעון את `web.whatsapp.com`. השתמש בפועל בוואטסאפ ווב (שליחה/קבלה של הודעה, טעינת תמונה) כדי לוודא שהכל עובד וכדי לתפוס בלוג את כל הדומיינים שבאמת נטענים.
7. **אחרי שהזמן פג** — ודא שהאתר נחסם מחדש לבד, בלי פעולה נוספת.
8. בדוק את `/api/log` או את הדוח בטאב **"היסטוריה"** בלוח הבקרה, ואם מופיעים דומיינים נוספים של וואטסאפ שלא ברשימה המקורית (`web.whatsapp.com`, `static.whatsapp.net`) — הוסף אותם דרך כפתור **"ערוך דומיינים"** ליד WhatsApp Web בטאב **"יצירת דומיינים"**.

## פתרון תקלות נפוצות

| תקלה | מה לבדוק |
|---|---|
| `EADDRINUSE` על פורט 53 | `Get-Service | Where-Object {$_.Name -like "*Shared*" -or $_.DisplayName -like "*DNS*"}` — לרוב ICS. שאל את ההורה לפני שמכבים שירות קיים |
| `better-sqlite3` נכשל בהתקנה | דורש Visual Studio Build Tools (C++). עצור ושאל את ההורה לפני התקנה כבדה |
| Chrome עדיין מראה Secure DNS פעיל | כרום צריך **restart מלא** (לא רק סגירת חלון) כדי לטעון מדיניות חדשה מה-Registry; בדוק ב-`chrome://policy` שהמדיניות מוצגת כ"Applied" |
| `kids.musagim-bamaharal.org` לא נטען | תן כמה דקות להפצת DNS; ודא ש-`cloudflared` השירות רץ: `Get-Service cloudflared` |
| וואטסאפ עדיין לא נטען אחרי גרנט | ה-TTL של תשובת ה-DNS הוא 30 שניות — חכה מעט; ודא שה-domain שהדפדפן באמת מנסה לטעון קיים ברשימת ה-domains של האתר בלוח הבקרה |

## מתי לעצור ולשאול את ההורה (חובה, לא אופציונלי)

- כל דבר לא צפוי בשלב 0 (תוכנת DNS/VPN/אבטחה קיימת, אי-ודאות לגבי חשבון הילד).
- לפני התקנת תוכנה/כלי build חדשים (Node, Build Tools, cloudflared) שלא כבר קיימים.
- לפני הסרת הרשאות Administrator מחשבון כלשהו (שלב 6).
- לפני/בזמן `cloudflared tunnel login` — זה דורש את ההורה בפועל מול הדפדפן.
- כל שגיאה שלא מופיעה בטבלת "פתרון תקלות" למעלה — אל תנסה "לעקוף" אותה בניחוש (למשל בביטול הרשאות, כיבוי Firewall, או `--force`); תעצור ותסביר להורה מה קרה.
