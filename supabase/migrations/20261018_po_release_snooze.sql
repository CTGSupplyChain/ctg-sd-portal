alter table public.po_release_lines add column if not exists snooze_until timestamptz; -- dismissed lines stay hidden until this time (next Monday 00:00 MYT)
