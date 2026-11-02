// =====================================================================
// 通知送信 Edge Function（毎日1回、日本時間 9:00 に呼ばれる想定）
//  - 振込予定日が「今日」で当日通知ON → 通知
//  - 振込予定日が「明日」で前日通知ON → 通知
//  - 毎月1日 → その月の振込予定のまとめを通知
// 秘密情報（VAPID鍵など）は Supabase の Secrets から読みます。
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:example@example.com";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

const jst = (d = new Date()) => new Date(d.getTime() + 9 * 60 * 60 * 1000);
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const yen = (n: number) => "¥" + n.toLocaleString("ja-JP");

Deno.serve(async (req) => {
  // 外部から勝手に叩かれないよう、合言葉をチェック
  if (CRON_SECRET && req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const now = jst();
  const today = ymd(now);
  const tomorrow = ymd(new Date(now.getTime() + 86400000));
  const monthPrefix = today.slice(0, 7);
  const isFirst = today.endsWith("-01");

  const { data: subs, error: se } = await sb.from("push_subscriptions").select("*");
  if (se) return new Response(se.message, { status: 500 });
  const byUser = new Map<string, any[]>();
  for (const s of subs ?? []) byUser.set(s.user_id, [...(byUser.get(s.user_id) ?? []), s]);

  const { data: jobs, error: je } = await sb
    .from("jobs").select("*")
    .or(`pay_date.eq.${today},pay_date.eq.${tomorrow},pay_date.like.${monthPrefix}%`);
  if (je) return new Response(je.message, { status: 500 });

  const messages: { user_id: string; title: string; body: string; tag: string }[] = [];
  const perUserMonth = new Map<string, { n: number; sum: number }>();
  for (const j of jobs ?? []) {
    if (j.pay_date === today && j.notify_day && j.status !== "paid") {
      messages.push({ user_id: j.user_id, title: "今日は振込予定日", body: `${j.name}（${yen(j.amount)}）が振り込まれる予定です`, tag: "day-" + j.id });
    }
    if (j.pay_date === tomorrow && j.notify_before && j.status !== "paid") {
      messages.push({ user_id: j.user_id, title: "明日は振込予定日", body: `${j.name}（${yen(j.amount)}）`, tag: "before-" + j.id });
    }
    if (j.pay_date.startsWith(monthPrefix)) {
      const m = perUserMonth.get(j.user_id) ?? { n: 0, sum: 0 };
      m.n += 1; m.sum += Number(j.amount); perUserMonth.set(j.user_id, m);
    }
  }
  if (isFirst) {
    const label = `${now.getUTCMonth() + 1}月`;
    for (const [uid, m] of perUserMonth) {
      messages.push({ user_id: uid, title: `${label}の振込予定`, body: `${m.n}件・合計 ${yen(m.sum)} の予定があります`, tag: "month-" + monthPrefix });
    }
    for (const uid of byUser.keys()) if (!perUserMonth.has(uid)) {
      messages.push({ user_id: uid, title: `${label}の振込予定`, body: "今月の振込予定はまだ登録されていません", tag: "month-" + monthPrefix });
    }
  }

  let sent = 0, removed = 0;
  for (const msg of messages) {
    for (const s of byUser.get(msg.user_id) ?? []) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify({ title: msg.title, body: msg.body, tag: msg.tag, url: "./" }));
        sent++;
      } catch (e: any) {
        if (e?.statusCode === 404 || e?.statusCode === 410) { await sb.from("push_subscriptions").delete().eq("id", s.id); removed++; }
        else console.error("push error", e?.statusCode, e?.body ?? e);
      }
    }
  }
  return new Response(JSON.stringify({ today, messages: messages.length, sent, removedStale: removed }), { headers: { "content-type": "application/json" } });
});
