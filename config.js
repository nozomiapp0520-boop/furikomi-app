// ===== 接続設定 =====
// Supabase の「Project URL」と「anon public key」を入れると、クラウド保存＋ログイン＋通知が有効になります。
// 空のままなら、この端末の中だけに保存する「ローカルモード」で動きます。
window.APP_CONFIG = {
  SUPABASE_URL: "https://pwalvwpmbawyimqtkkdy.supabase.co",
  SUPABASE_ANON_KEY: sb_publishable_URmpkYL5M7diLSZPIZFHyQ_Q_1HgE7j",
  // Web Push 用の VAPID 公開鍵（docs/SETUP.md の手順で作ります）
  VAPID_PUBLIC_KEY: ""
};
