-- =====================================================================
-- 毎日 日本時間 9:00（= UTC 0:00）に通知関数を呼び出す定期実行
-- 先に Edge Function「notify」をデプロイしてから、SQL Editor で実行してください。
-- <PROJECT_REF> と <CRON_SECRET> は自分の値に置き換えます（docs/SETUP.md 参照）。
-- =====================================================================
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('furikomi-notify') where exists (select 1 from cron.job where jobname = 'furikomi-notify');

select cron.schedule(
  'furikomi-notify',
  '0 0 * * *',   -- UTC 0:00 = 日本時間 9:00
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/notify',
    headers := '{"Content-Type": "application/json", "x-cron-secret": "<CRON_SECRET>"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- 確認： select * from cron.job;
-- 実行履歴： select * from cron.job_run_details order by start_time desc limit 10;
