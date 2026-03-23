create table if not exists public.johoe_btc_queue_snapshots (
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

create index if not exists idx_johoe_btc_queue_snapshots_snapshot_ts
  on public.johoe_btc_queue_snapshots (snapshot_ts desc);

alter table public.johoe_btc_queue_snapshots enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table public.johoe_btc_queue_snapshots from anon';
  end if;

  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.johoe_btc_queue_snapshots from authenticated';
  end if;
end
$$;

create table if not exists public.johoe_forward_outbox (
  snapshot_ts_unix bigint primary key references public.johoe_btc_queue_snapshots(snapshot_ts_unix) on delete cascade,
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
