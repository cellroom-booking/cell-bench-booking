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
