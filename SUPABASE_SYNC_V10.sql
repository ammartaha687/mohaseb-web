-- MOHASEB CENTRAL SYNC v9
-- آمن: لا DROP / TRUNCATE / DELETE.
-- نفّذ هذا الملف مرة واحدة في Supabase SQL Editor.

create table if not exists public.mohaseb_sync_state (
  store_name text primary key,
  version bigint not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid null,
  data jsonb not null default '[]'::jsonb
);

create or replace function public.mohaseb_sync_get(p_store_name text)
returns table(version bigint, updated_at timestamptz, updated_by uuid, data jsonb)
language sql
security definer
set search_path = public
as $$
  select s.version, s.updated_at, s.updated_by, s.data
  from public.mohaseb_sync_state s
  where s.store_name = p_store_name
  limit 1;
$$;

create or replace function public.mohaseb_sync_commit(
  p_store_name text,
  p_base_version bigint,
  p_data jsonb,
  p_device_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_version bigint;
  current_data jsonb;
  new_version bigint;
begin
  if p_store_name is null or length(trim(p_store_name)) = 0 then
    return jsonb_build_object('ok',false,'error','store_name is required');
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'array' then
    return jsonb_build_object('ok',false,'error','data must be a JSON array');
  end if;

  select version, data into current_version, current_data
  from public.mohaseb_sync_state
  where store_name = p_store_name
  for update;

  if not found then
    if coalesce(p_base_version,0) <> 0 then
      return jsonb_build_object('ok',false,'conflict',true,'version',0,'data','[]'::jsonb);
    end if;
    insert into public.mohaseb_sync_state(store_name,version,updated_at,updated_by,data)
    values(p_store_name,1,now(),p_device_id,p_data);
    return jsonb_build_object('ok',true,'version',1);
  end if;

  if current_version <> coalesce(p_base_version,0) then
    return jsonb_build_object('ok',false,'conflict',true,'version',current_version,'data',current_data);
  end if;

  new_version := current_version + 1;
  update public.mohaseb_sync_state
  set version=new_version, updated_at=now(), updated_by=p_device_id, data=p_data
  where store_name=p_store_name;
  return jsonb_build_object('ok',true,'version',new_version);
end;
$$;

revoke all on table public.mohaseb_sync_state from anon, authenticated;
grant execute on function public.mohaseb_sync_get(text) to anon, authenticated;
grant execute on function public.mohaseb_sync_commit(text,bigint,jsonb,uuid) to anon, authenticated;
