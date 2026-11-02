# セットアップ手順（Supabase 作成 → 公開 → 使う人に渡す）

このアプリは「ホーム画面に追加して使う Web アプリ（PWA）」です。
App Store は使いません。公開した URL を Safari で開いて「ホーム画面に追加」すると、普通のアプリのように使えます。

全体の流れ：

1. Supabase のアカウントとプロジェクトを作る（無料）
2. テーブルを作る（SQL を貼って実行）
3. ログイン（メールのコード）の設定
4. アプリを GitHub Pages で公開する
5. `config.js` に Supabase の接続先を入れる
6. 通知の仕組み（VAPID 鍵・関数・毎日の定期実行）を入れる
7. 使う人に渡す

所要時間の目安：1〜7 を通しで 1 時間くらい。6 の通知は後回しにしても 1〜5 だけでアプリは使えます。

---

## 1. Supabase のアカウントとプロジェクトを作る

1. https://supabase.com を開き、右上の **Start your project** → **Sign in with GitHub** でログイン（GitHub アカウントがなければ先に作る）。
2. **New project** を押す。
   - Organization：そのまま（自分の名前のもの）
   - Name：`furikomi` など好きな名前
   - Database Password：**自動生成（Generate）を押して、出てきた文字列をどこかにメモ**。あとで基本使いませんが、無くすと面倒です。
   - Region：**Northeast Asia (Tokyo)**
   - Pricing Plan：**Free**
3. **Create new project** を押し、1〜2 分待つ。

### 控えておく値（あとで使います）

左メニュー **Project Settings（歯車）→ API** を開く：

| 名前 | 場所 | 使う場所 |
|---|---|---|
| **Project URL** | API → Project URL（`https://xxxx.supabase.co`） | `config.js` |
| **anon public** キー | API → Project API keys → `anon` `public` | `config.js` |
| **Project ref**（URL の `xxxx` の部分） | 同上 | `cron.sql` |

`service_role` キーは **使いません**（公開してはいけない鍵です。`config.js` に入れないでください）。

---

## 2. テーブルを作る

1. 左メニュー **SQL Editor** → **New query**。
2. このリポジトリの `supabase/schema.sql` の中身を全部コピーして貼り付け → **Run**。
3. 「Success. No rows returned」と出れば OK。左メニュー **Table Editor** に `jobs` `boards` `columns` `cards` `push_subscriptions` の 5 つができています。

> 「自分のデータは自分しか見えない」設定（RLS）もこの SQL に入っています。複数人が同じアプリを使っても、お互いのデータは見えません。

---

## 3. ログインの設定（画面なしの自動ログイン）

このアプリにはログイン画面がありません。初めて開いたときに裏で自動的にアカウントが作られ、以後はその iPhone（のそのアプリ）にデータが紐づきます。

1. 左メニュー **Authentication → Sign In / Providers**（または Settings）を開く。
2. **User Signups** の中の **Allow anonymous sign-ins** を **ON** → **Save changes**。
3. **Email** プロバイダはそのままで OK（使いません）。

> 注意：アプリを削除して入れ直す／機種変更すると、前のデータは引き継げません（新しいアカウントになります）。
> 引き継ぎが必要になったら、メールで引き継ぐ機能を後から追加できます。

---

## 4. アプリを GitHub Pages で公開する

1. https://github.com で **New repository**。名前は `furikomi-app`、**Public**、そのまま Create。
2. このフォルダの中身（`index.html` `app.js` `styles.css` `config.js` `sw.js` `manifest.webmanifest` `icons/` `supabase/` `docs/`）をリポジトリにアップロードする。
   - ブラウザから：リポジトリの **Add file → Upload files** にフォルダごとドラッグ → **Commit changes**
   - Git を使うなら：
     ```bash
     cd furikomi-app
     git init && git add . && git commit -m "first"
     git branch -M main
     git remote add origin https://github.com/ユーザー名/furikomi-app.git
     git push -u origin main
     ```
3. リポジトリの **Settings → Pages**：
   - Source：**Deploy from a branch**
   - Branch：`main` / `/ (root)` → **Save**
4. 1〜2 分で `https://ユーザー名.github.io/furikomi-app/` が開けるようになります。これが**アプリの URL**です。

> この時点では `config.js` が空なので「ローカルモード」（端末内だけに保存）で動きます。次の手順でクラウドに切り替えます。

---

## 5. `config.js` に接続先を入れる

`config.js` を開いて、手順 1 で控えた値を入れます：

```js
window.APP_CONFIG = {
  SUPABASE_URL: "https://xxxx.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOi...（長い文字列）",
  VAPID_PUBLIC_KEY: ""   // ← 手順 6 で入れる。今は空でOK
};
```

保存して GitHub にもう一度アップロード（または `git commit` → `git push`）。
公開 URL を開き直すと、ログイン画面が出るようになります。

**動作確認**：自分のメールアドレスでログイン → 予定を 1 件追加 → Supabase の **Table Editor → jobs** に行が増えていれば成功。

---

## 6. 通知（毎月 1 日の朝 ＋ 各予定日の朝）

通知は「サーバーが毎朝 9:00 にチェックして、iPhone に送る」仕組みです。3 つの部品を入れます。

### 6-1. VAPID 鍵（プッシュ通知の署名用の鍵ペア）を作る

パソコンに Node.js が入っていれば：

```bash
npx web-push generate-vapid-keys
```

`Public Key:` と `Private Key:` が出ます。両方メモ。
（Node.js がなければ https://vapidkeys.com のような生成サイトでも作れます。鍵は一度作ったら変えないでください。変えると全員の通知登録がやり直しになります。）

- **Public Key** → `config.js` の `VAPID_PUBLIC_KEY` に入れて、再アップロード。
- **Private Key** → 次の 6-2 で Supabase の Secrets に入れる（コードには書かない）。

### 6-2. 通知関数（Edge Function）をデプロイする

Supabase CLI を使います（一度だけの作業）。

```bash
# Supabase CLI を入れる（Mac: brew / Windows: scoop か npx）
npm install -g supabase

cd furikomi-app
supabase login                       # ブラウザが開くので許可
supabase link --project-ref xxxx     # 手順1で控えた Project ref

# 秘密情報を登録（CRON_SECRET は自分で決めた合言葉。英数字の長めの文字列）
supabase secrets set VAPID_PUBLIC_KEY="（公開鍵）" VAPID_PRIVATE_KEY="（秘密鍵）" VAPID_SUBJECT="mailto:自分のメールアドレス" CRON_SECRET="好きな合言葉"

# 関数をデプロイ
supabase functions deploy notify --no-verify-jwt
```

動作テスト（今日が予定日のデータがなければ `sent: 0` でも正常）：

```bash
curl -X POST "https://xxxx.supabase.co/functions/v1/notify" -H "x-cron-secret: 好きな合言葉"
# → {"today":"2026-11-02","messages":0,"sent":0,"removedStale":0}
```

### 6-3. 毎朝 9:00 に自動で動かす

1. Supabase ダッシュボード → **Database → Extensions** で `pg_cron` と `pg_net` を **有効（Enable）** にする。
2. `supabase/cron.sql` を開き、`<PROJECT_REF>` と `<CRON_SECRET>` を自分の値に書き換える。
3. **SQL Editor** に貼り付けて **Run**。
4. 確認：SQL Editor で `select * from cron.job;` を実行して `furikomi-notify` が 1 行あれば OK。

翌朝 9:00 以降に `select * from cron.job_run_details order by start_time desc limit 5;` で実行履歴が見られます。

### 通知が届く条件（使う人に伝えること）

- iPhone は **iOS 16.4 以降**
- **Safari で開いて「ホーム画面に追加」し、そのアイコンから起動**していること（Safari のタブのままでは通知は出ません）
- アプリ内の下にある **鈴のバナーをタップして「許可」**していること

---

## 7. 使う人に渡す手順

渡すのは **URL ひとつ**だけです。相手に送る案内文（そのままコピペで使えます）：

```
【振込予定アプリの使い方】

1. iPhone の Safari でこの URL を開く
   https://ユーザー名.github.io/furikomi-app/

2. 画面下の「共有」ボタン（□に↑のマーク）→「ホーム画面に追加」→「追加」
   ホーム画面に三日月のアイコンができます。以後はこのアイコンから開いてください。

3. アイコンから開くと、そのまま使えます（ログイン不要）

4. 一番下の鈴のバナーをタップして、通知を「許可」
   → 毎月 1 日の朝 9 時と、各振込予定日の朝に通知が届きます

使い方
・右上の＋ で振込予定を追加（案件名・事務所/個人・振込予定日・金額）
・振り込まれたら左の☆をタップ → 振込済みになります
・期限を過ぎてまだの予定はピンクになります
・月の表示は ‹ › で切り替え、▦ でカレンダー表示
・Todo タブ：メモを長押しして別の枠へドラッグ。枠の名前は ✎ で変更、＋枠を追加／＋ボードで増やせます
・ボード名をタップ長押しで名前変更

困ったとき
・データはこの iPhone のアプリにだけ紐づいていて、他の人からは見えません
・アプリを削除すると前のデータは消えます（入れ直す前に教えてください）
```

### 複数人に渡す場合

- 同じ URL をそれぞれに送るだけで OK。端末ごとに別のアカウントが自動で作られ、データは完全に分かれます。
- 無料枠の目安：ユーザー数は実質無制限、データ 500MB。数人〜十数人の個人利用なら十分です。

---

## 困ったときの早見表

| 症状 | 見るところ |
|---|---|
| 「サーバーに接続できないため…」と出る | `config.js` の URL とキー、Authentication の Allow anonymous sign-ins が ON か |
| 「保存に失敗しました」と出る | 手順 2 の SQL が通っているか（Table Editor に 5 テーブルあるか） |
| 通知を許可しても届かない | ホーム画面のアイコンから起動しているか／`VAPID_PUBLIC_KEY` が入っているか／`cron.job` に登録があるか／`cron.job_run_details` のエラー |
| 鈴のバナーが「この表示では通知が使えません」 | Safari のタブで開いている。ホーム画面に追加して、そこから開く |
| 古い画面のまま更新されない | アプリを完全に閉じて開き直す（Service Worker のキャッシュ更新） |
