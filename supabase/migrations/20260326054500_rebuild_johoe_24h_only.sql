drop table if exists public.johoe_forward_outbox;
drop table if exists public.johoe_queue_30d_rolling;
drop table if exists public.johoe_queue_all_daily;
drop table if exists public.johoe_queue_24h_rolling;

create table public.johoe_queue_24h_rolling (
  snapshot_ts_unix bigint primary key,
  snapshot_ts timestamptz not null,
  count_buckets jsonb not null,
  weight_buckets jsonb not null,
  fee_buckets jsonb not null,
  count_total bigint not null,
  weight_total bigint not null,
  fee_total bigint not null,
  fetched_at timestamptz not null default now()
);

create index if not exists idx_johoe_queue_24h_rolling_snapshot_ts
  on public.johoe_queue_24h_rolling (snapshot_ts desc);

create index if not exists idx_johoe_queue_24h_rolling_snapshot_ts_unix
  on public.johoe_queue_24h_rolling (snapshot_ts_unix desc);

alter table public.johoe_queue_24h_rolling enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table public.johoe_queue_24h_rolling from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.johoe_queue_24h_rolling from authenticated';
  end if;
end
$$;
