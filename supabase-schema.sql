create extension if not exists btree_gist with schema extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.bookings (
  id uuid primary key default extensions.gen_random_uuid(),
  bench_id text not null check (
    bench_id in (
      'west-1-inside',
      'west-1-outside',
      'west-2-inside',
      'west-2-outside',
      'east-window',
      'east-wall'
    )
  ),
  booking_date date not null,
  start_time time not null,
  end_time time not null,
  person text not null check (char_length(trim(person)) between 1 and 40),
  created_at timestamptz not null default now(),
  check (end_time > start_time)
);

do $$
declare
  constraint_record record;
begin
  for constraint_record in
    select conname, pg_get_constraintdef(oid) as definition
    from pg_constraint
    where conrelid = 'public.bookings'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%start_time%'
      and pg_get_constraintdef(oid) ilike '%end_time%'
      and (
        pg_get_constraintdef(oid) ilike '%07:00%'
        or pg_get_constraintdef(oid) ilike '%23:00%'
      )
  loop
    execute format('alter table public.bookings drop constraint %I', constraint_record.conname);
  end loop;
end $$;

alter table public.bookings
  drop constraint if exists no_booking_overlap;

alter table public.bookings
  add constraint no_booking_overlap
  exclude using gist (
    bench_id with =,
    booking_date with =,
    tsrange(
      (booking_date + start_time)::timestamp,
      (booking_date + end_time)::timestamp,
      '[)'
    ) with &&
  );

alter table public.bookings enable row level security;

drop policy if exists "bookings_select_public" on public.bookings;
drop policy if exists "bookings_insert_public" on public.bookings;
drop policy if exists "bookings_delete_public" on public.bookings;

create policy "bookings_select_public"
  on public.bookings for select
  using (true);

create policy "bookings_insert_public"
  on public.bookings for insert
  with check (true);

create policy "bookings_delete_public"
  on public.bookings for delete
  using (true);

grant usage on schema public to anon, authenticated;
grant select, insert, delete on public.bookings to anon, authenticated;

do $$
begin
  begin
    alter publication supabase_realtime add table public.bookings;
  exception
    when duplicate_object then null;
  end;
end $$;
