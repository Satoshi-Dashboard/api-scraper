create table if not exists public.johoe_queue_all_daily (
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

create index if not exists idx_johoe_queue_all_daily_snapshot_ts
  on public.johoe_queue_all_daily (snapshot_ts desc);

alter table public.johoe_queue_all_daily enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table public.johoe_queue_all_daily from anon';
  end if;

  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.johoe_queue_all_daily from authenticated';
  end if;
end
$$;

create table if not exists public.johoe_queue_24h_rolling (
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

create table if not exists public.johoe_queue_30d_rolling (
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

create index if not exists idx_johoe_queue_30d_rolling_snapshot_ts
  on public.johoe_queue_30d_rolling (snapshot_ts desc);

alter table public.johoe_queue_30d_rolling enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table public.johoe_queue_30d_rolling from anon';
  end if;

  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.johoe_queue_30d_rolling from authenticated';
  end if;
end
$$;

drop table if exists public.johoe_forward_outbox;

create table public.johoe_forward_outbox (
  snapshot_ts_unix bigint primary key,
  source_table text not null,
  payload jsonb not null,
  attempts integer not null default 0,
  last_attempt_at timestamptz,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_johoe_forward_outbox_pending
  on public.johoe_forward_outbox (snapshot_ts_unix)
  where delivered_at is null;

alter table public.johoe_forward_outbox enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table public.johoe_forward_outbox from anon';
  end if;

  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.johoe_forward_outbox from authenticated';
  end if;
end
$$;
