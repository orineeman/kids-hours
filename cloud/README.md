# קצה ענן (Cloudflare Worker + D1)

מקור האמת לרשימת האתרים והגרנטים, ולוח הבקרה של ההורה. תיעוד להתקנה חד-פעמית — לא ניתן לבצע את השלבים האלה בשבילכם (דורש התחברות לחשבון Cloudflare שלכם).

## למה PBKDF2 ולא bcrypt

Cloudflare Workers בתוכנית החינמית מגבילים זמן CPU לבקשה. `bcrypt` (cost 12, כמו במערכת המקומית) לוקח מעל 200ms של CPU טהור — חורג מהמגבלה. `PBKDF2` דרך `crypto.subtle` המובנה (native WebCrypto) מהיר בהרבה ובלי תלות חיצונית. המשמעות: ההורה מגדיר סיסמה **חדשה** בזמן המעבר לענן — הסיסמה הישנה לא "עוברת".

## התקנה חד-פעמית

```bash
cd cloud
npm install
npx wrangler login          # פותח דפדפן, מתחברים לחשבון Cloudflare הקיים

npx wrangler d1 create kids-hours
# מדביקים את ה-database_id שמודפס לתוך wrangler.toml (שדה database_id)

npm run db:migrate:remote   # מריץ את migrations/0001_init.sql על ה-D1 האמיתי

npx wrangler secret put SESSION_SECRET
# מדביקים מחרוזת אקראית ארוכה, למשל מה-output של: openssl rand -hex 32

npm run deploy
```

זה מדפיס כתובת `*.workers.dev` שאפשר לבדוק בה מיד (מסך "הגדרת חשבון הורה" אמור להופיע).

**לחבר לדומיין הקיים** (`kids.musagim-bamaharal.org`): בלוח הבקרה של Cloudflare → הדומיין → Workers Routes → מוסיפים route שמצביע על ה-Worker הזה (`kids-hours-api`) לתבנית `kids.musagim-bamaharal.org/*`. אין צורך יותר ב-`cloudflared`/Tunnel בכלל — אפשר להסיר את השירות מהמחשב של הילדים.

## יצירת טוקן למכשיר (המחשב של הילדים)

אין מסך הרשמה עצמית — בכוונה (שטח תקיפה קטן יותר, וזו מערכת למשפחה אחת, לא SaaS). מריצים פעם אחת:

```bash
npm run device:create -- "kids-pc"
```

זה מדפיס טוקן (`dev_xxxx.yyyy`) **פעם אחת** — מעתיקים אותו לשדה "Device Token" באשף ההתקנה של Windows, ומריצים את פקודת ה-`wrangler d1 execute` שהוא מדפיס כדי לרשום אותו בפועל.

לביטול מכשיר (מחשב אבד/נחשד): `DELETE /api/devices/<id>` מלוח הבקרה, או ידנית ב-D1.

## העברת קטלוג האתרים הקיים (אופציונלי)

אם יש כבר `data/app.db` על המחשב עם רשימת אתרים שלא רוצים להגדיר מחדש:

```bash
npm run migrate:from-local-db -- /path/to/app.db
```

מדפיס פקודות `wrangler d1 execute` להרצה (לא מריץ אוטומטית — כדי שתוכלו לבדוק כל שורה לפני שמריצים אותה).

## פיתוח מקומי

```bash
npm run db:migrate:local   # פעם אחת, D1 מקומי בתוך wrangler
npm run dev                # wrangler dev --local, ברירת מחדל http://localhost:8787
```
