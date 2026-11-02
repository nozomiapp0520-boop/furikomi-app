-- =====================================================================
-- 振込予定 & Todo — Supabase テーブル定義
-- Supabase ダッシュボード → SQL Editor にこのファイルの中身を貼り付けて Run
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- 振込予定 ----------
create table if not exists public.jobs (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name          text not null,
  kind          text not null default 'office' check (kind in ('office','personal')),
  pay_date      date not null,
  amount        integer not null default 0,
  status        text not null default 'pending' check (status in ('pending','paid')),
  memo          text,
  notify_day    boolean not null default true,
  notify_before boolean not null default false,
  notify_time   time not null default '09:00',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ---------- Todo ----------
create table if not exists public.boards (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name      text not null,
  position  integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.columns (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  board_id  uuid not null references public.boards(id) on delete cascade,
  title     text not null,
  color     text not null default '#8FA3A4',
  position  integer not null default 0
);

create table if not exists public.cards (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  board_id  uuid not null references public.boards(id) on delete cascade,
  column_id uuid not null references public.columns(id) on delete cascade,
  text      text not null,
  due       date,
  job_id    uuid references public.jobs(id) on delete set null,
  position  integer not null default 0,
  created_at timestamptz not null default now()
);

-- ---------- プッシュ通知の宛先 ----------
create table if not exists public.push_subscriptions (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  endpoint  text not null unique,
  p256dh    text not null,
  auth      text not null,
  created_at timestamptz not null default now()
);

-- updated_at を自動更新
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists jobs_touch on public.jobs;
create trigger jobs_touch before update on public.jobs for each row execute function public.touch_updated_at();

-- ---------- 行レベルセキュリティ（自分のデータしか見えない） ----------
alter table public.jobs enable row level security;
alter table public.boards enable row level security;
alter table public.columns enable row level security;
alter table public.cards enable row level security;
alter table public.push_subscriptions enable row level security;

do $$
declare t text;
begin
  foreach t in array array['jobs','boards','columns','cards','push_subscriptions'] loop
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format('create policy "own rows" on public.%I for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;

create index if not exists jobs_user_date on public.jobs(user_id, pay_date);
create index if not exists cards_col on public.cards(column_id, position);
