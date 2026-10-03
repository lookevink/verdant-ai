-- Application data stays behind server-only, SECURITY INVOKER RPCs.
-- No PostGIS/GDAL or pgvector dependency: decode climate rasters outside Postgres.
create schema verdant;
revoke all on schema verdant from public, anon, authenticated;
grant usage on schema verdant to service_role;
alter default privileges in schema verdant revoke execute on functions from public;

create domain verdant.environment as text check (value in ('sandbox', 'production'));
create domain verdant.sha256 as text check (value ~ '^[0-9a-f]{64}$');
create function verdant.finite_array(v double precision[]) returns boolean
language sql immutable strict set search_path = '' as $$
  select not exists (select 1 from unnest(v) x where x in ('NaN'::float8, 'Infinity'::float8, '-Infinity'::float8));
$$;
create function verdant.valid_bbox(v double precision[]) returns boolean
language sql immutable strict set search_path = '' as $$
  select coalesce(array_ndims(v)=1 and array_lower(v,1)=1 and cardinality(v)=4
    and array_position(v,null) is null and verdant.finite_array(v)
    and v[1]>=-180 and v[3]<=180 and v[2]>=-90 and v[4]<=90
    and v[1]<v[3] and v[2]<v[4],false);
$$;

create table verdant.dataset_versions (
  environment verdant.environment not null,
  id text not null check (id ~ '^[a-zA-Z0-9_-]{1,128}$'),
  dataset_key text not null,
  title text not null,
  content_sha256 verdant.sha256 not null,
  source_manifest jsonb not null check (jsonb_typeof(source_manifest)='array' and jsonb_array_length(source_manifest)>0),
  transform_version text not null,
  data_class text not null check (data_class in ('observation','interpolated_observation','forecast','simulation','published_aggregate')),
  variables jsonb not null check (jsonb_typeof(variables)='object' and variables<>'{}'),
  temporal_resolution text not null,
  spatial_support jsonb not null check (jsonb_typeof(spatial_support)='object'),
  bbox double precision[] check (verdant.valid_bbox(bbox)),
  period_start date not null,
  period_end date not null check (period_end>=period_start),
  license text not null,
  attribution text not null,
  access_level text not null default 'restricted' check (access_level in ('demo','paid','restricted')),
  status text not null default 'staging' check (status in ('staging','published','retired')),
  metadata jsonb not null default '{}' check (jsonb_typeof(metadata)='object'),
  created_at timestamptz not null default now(),
  published_at timestamptz,
  primary key (environment,id),
  unique (environment,dataset_key,content_sha256,transform_version),
  check ((status='published')=(published_at is not null) or status='retired')
);
create index dataset_catalog on verdant.dataset_versions(environment,status,dataset_key,period_start,period_end);

-- Long-form values retain native support and source record identity, including missing values.
create table verdant.observations (
  environment verdant.environment not null,
  dataset_version_id text not null,
  id text not null,
  variable text not null,
  value double precision check (value not in ('NaN'::float8,'Infinity'::float8,'-Infinity'::float8)),
  unit text not null,
  observed_on date,
  period_label text,
  entity_id text not null,
  dimensions jsonb not null default '{}' check (jsonb_typeof(dimensions)='object'),
  quality_flags jsonb not null default '[]' check (jsonb_typeof(quality_flags)='array'),
  primary key (environment,dataset_version_id,id),
  foreign key (environment,dataset_version_id) references verdant.dataset_versions(environment,id),
  check (observed_on is not null or period_label is not null)
);
create index observation_series on verdant.observations(environment,dataset_version_id,variable,observed_on,id);

create table verdant.raster_tiles (
  environment verdant.environment not null,
  dataset_version_id text not null,
  id text not null,
  variable text not null,
  unit text not null,
  observed_on date not null,
  width integer not null check (width between 1 and 256),
  height integer not null check (height between 1 and 256),
  crs text not null,
  -- Affine [a,b,c,d,e,f]; top-down row-major, source pixel centers at col+.5,row+.5.
  transform double precision[] not null check (coalesce(cardinality(transform)=6 and array_ndims(transform)=1
    and array_lower(transform,1)=1 and array_position(transform,null) is null and verdant.finite_array(transform),false)),
  bbox double precision[] not null check (verdant.valid_bbox(bbox)),
  cells real[] not null check (coalesce(array_ndims(cells)=1 and array_lower(cells,1)=1
    and cardinality(cells)=width*height and verdant.finite_array(cells::double precision[]),false)),
  source_window integer[] not null check (cardinality(source_window)=4 and array_position(source_window,null) is null),
  primary key (environment,dataset_version_id,id),
  foreign key (environment,dataset_version_id) references verdant.dataset_versions(environment,id)
);
create index raster_lookup on verdant.raster_tiles(environment,dataset_version_id,variable,observed_on);

create table verdant.data_quotes (
  environment verdant.environment not null,
  id uuid not null default gen_random_uuid(),
  requester_hash verdant.sha256 not null,
  request_digest verdant.sha256 not null,
  request jsonb not null check (jsonb_typeof(request)='object'),
  source_selection jsonb not null check (jsonb_typeof(source_selection)='object'),
  limits jsonb not null check (jsonb_typeof(limits)='object'),
  amount_minor bigint not null check (amount_minor>=0),
  currency text not null check (currency ~ '^[a-z]{3}$'),
  payment_mode text not null check (payment_mode in ('test','live')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (environment,id),
  check (environment<>'sandbox' or payment_mode='test'),
  check (expires_at>created_at)
);
create table verdant.payment_operations (
  environment verdant.environment not null,
  id uuid not null default gen_random_uuid(),
  payment_mode text not null check (payment_mode in ('test','live')),
  provider text not null,
  reference text not null,
  credential_hash verdant.sha256 not null,
  request_digest verdant.sha256 not null,
  amount_minor bigint not null check (amount_minor>=0),
  currency text not null check (currency ~ '^[a-z]{3}$'),
  status text not null check (status in ('verified','refund_pending','refunded','reconciliation_required')),
  receipt text not null,
  created_at timestamptz not null default now(),
  primary key (environment,id),
  unique (environment,payment_mode,provider,reference),
  unique (environment,payment_mode,credential_hash),
  check (environment<>'sandbox' or payment_mode='test')
);
create table verdant.data_requests (
  environment verdant.environment not null,
  id uuid not null default gen_random_uuid(),
  quote_id uuid not null,
  payment_operation_id uuid not null,
  requester_hash verdant.sha256 not null,
  access_token_hash verdant.sha256 not null,
  idempotency_key text not null check (length(idempotency_key) between 1 and 128),
  status text not null default 'queued' check (status in ('queued','acquiring','normalizing','validating','publishing','ready','failed','cancelled')),
  error jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (environment,id),
  unique (environment,quote_id),
  unique (environment,payment_operation_id),
  unique (environment,requester_hash,idempotency_key),
  foreign key (environment,quote_id) references verdant.data_quotes(environment,id),
  foreign key (environment,payment_operation_id) references verdant.payment_operations(environment,id)
);
create table verdant.request_events (
  environment verdant.environment not null,
  request_id uuid not null,
  id bigint generated always as identity,
  event text not null,
  details jsonb not null default '{}' check (jsonb_typeof(details)='object' and octet_length(details::text)<=32768),
  created_at timestamptz not null default now(),
  primary key (environment,request_id,id),
  foreign key (environment,request_id) references verdant.data_requests(environment,id)
);
create table verdant.artifacts (
  environment verdant.environment not null,
  id uuid not null default gen_random_uuid(),
  request_id uuid not null,
  dataset_version_id text not null,
  format text not null check (format in ('json','csv','raster_json')),
  storage_bucket text not null,
  storage_path text not null,
  sha256 verdant.sha256 not null,
  byte_count bigint not null check (byte_count>=0),
  manifest jsonb not null check (jsonb_typeof(manifest)='object'),
  created_at timestamptz not null default now(),
  primary key (environment,id),
  unique (environment,request_id,format),
  foreign key (environment,request_id) references verdant.data_requests(environment,id),
  foreign key (environment,dataset_version_id) references verdant.dataset_versions(environment,id)
);
create index artifact_dataset on verdant.artifacts(environment,dataset_version_id);
create table verdant.analysis_runs (
  environment verdant.environment not null,
  id uuid not null default gen_random_uuid(),
  dataset_version_id text not null,
  requester_hash verdant.sha256,
  inputs jsonb not null,
  result jsonb not null,
  algorithm_version text not null,
  created_at timestamptz not null default now(),
  primary key (environment,id),
  foreign key (environment,dataset_version_id) references verdant.dataset_versions(environment,id)
);
create index analysis_dataset on verdant.analysis_runs(environment,dataset_version_id);

-- RLS without browser policies is intentional: paid data must not bypass the API.
do $$ declare t record; begin
  for t in select tablename from pg_tables where schemaname='verdant' loop
    execute format('alter table verdant.%I enable row level security',t.tablename);
    execute format('revoke all on verdant.%I from public, anon, authenticated',t.tablename);
  end loop;
end $$;
grant select,insert,update,delete on all tables in schema verdant to service_role;
grant usage,select on all sequences in schema verdant to service_role;
grant execute on all functions in schema verdant to service_role;

create function public.verdant_catalog(p_environment text) returns jsonb
language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(d) order by d.dataset_key,d.id),'[]'::jsonb)
 from verdant.dataset_versions d where d.environment=p_environment and d.status='published' and d.access_level<>'restricted';
$$;
create function public.verdant_observations(p_environment text,p_dataset text,p_after text default '',p_limit integer default 1000) returns jsonb
language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(o) order by o.id),'[]'::jsonb) from (
 select o.* from verdant.observations o join verdant.dataset_versions d on (d.environment,d.id)=(o.environment,o.dataset_version_id)
 where o.environment=p_environment and o.dataset_version_id=p_dataset and o.id>p_after and d.status='published'
 order by o.id limit greatest(1,least(coalesce(p_limit,1000),1000))) o;
$$;
create function public.verdant_raster_tile(p_environment text,p_dataset text,p_tile text) returns jsonb
language sql stable security invoker set search_path='' as $$
 select to_jsonb(t) from verdant.raster_tiles t join verdant.dataset_versions d on (d.environment,d.id)=(t.environment,t.dataset_version_id)
 where t.environment=p_environment and t.dataset_version_id=p_dataset and t.id=p_tile and d.status='published';
$$;
create function public.verdant_raster_index(p_environment text,p_dataset text) returns jsonb
language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]'::jsonb) from (
 select r.id,r.variable,r.unit,r.observed_on,r.width,r.height,r.crs,r.transform,r.bbox
 from verdant.raster_tiles r join verdant.dataset_versions d on (d.environment,d.id)=(r.environment,r.dataset_version_id)
 where r.environment=p_environment and r.dataset_version_id=p_dataset and d.status='published' order by r.id limit 1000) t;
$$;
do $$ declare f record; begin
 for f in select oid::regprocedure as signature from pg_proc where pronamespace='public'::regnamespace and proname like 'verdant_%' loop
 execute format('revoke all on function %s from public,anon,authenticated',f.signature);
 execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
