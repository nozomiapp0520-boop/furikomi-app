# 振込予定 & Todo（iPhone 向け PWA）

- `index.html` / `styles.css` / `app.js` … アプリ本体（ビルド不要・そのまま公開できます）
- `config.js` … Supabase の接続先（空ならローカルモード）
- `sw.js` / `manifest.webmanifest` / `icons/` … ホーム画面追加・オフライン・通知用
- `supabase/schema.sql` … テーブルと権限（SQL Editor で実行）
- `supabase/functions/notify/` … 通知を送る関数
- `supabase/cron.sql` … 毎朝 9:00 の定期実行
- `docs/SETUP.md` … **アカウント作成から公開、使う人への渡し方まで**

手元で試すには、このフォルダで `python3 -m http.server 8787` を実行して http://localhost:8787 を開くだけで動きます（ローカルモード）。
