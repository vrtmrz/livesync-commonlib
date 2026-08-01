begin;

create schema if not exists livesync_private;
create schema if not exists livesync_api;

do $bootstrap$
declare
    extension_schema text;
begin
    if not exists (select 1 from pg_extension where extname = 'pgcrypto') then
        create extension pgcrypto with schema livesync_private;
    end if;
    select namespace_entry.nspname
      into extension_schema
      from pg_extension extension_entry
      join pg_namespace namespace_entry on namespace_entry.oid = extension_entry.extnamespace
     where extension_entry.extname = 'pgcrypto';
    execute format(
        'create or replace function livesync_private.sha256(payload bytea)
         returns bytea language sql immutable strict security invoker
         set search_path = pg_catalog
         as $function$ select %I.digest(payload, ''sha256'') $function$',
        extension_schema
    );
    execute format(
        'create or replace function livesync_private.random_bytes(byte_length integer)
         returns bytea language sql volatile strict security invoker
         set search_path = pg_catalog
         as $function$ select %I.gen_random_bytes(byte_length) $function$',
        extension_schema
    );
end
$bootstrap$;

do $$
begin
    if not exists (
        select 1
          from pg_type type_entry
          join pg_namespace namespace_entry on namespace_entry.oid = type_entry.typnamespace
         where namespace_entry.nspname = 'livesync_api'
           and type_entry.typname = 'application/octet-stream'
    ) then
        create domain livesync_api."application/octet-stream" as bytea;
    end if;
end
$$;

create table if not exists livesync_private.adaptive_vaults (
    vault_id text primary key,
    credential_digest bytea not null check (octet_length(credential_digest) = 32),
    created_at timestamptz not null default statement_timestamp(),
    check (vault_id ~ '^[A-Za-z0-9_-]{16,128}$')
);

create table if not exists livesync_private.adaptive_v1_manifests (
    vault_id text primary key references livesync_private.adaptive_vaults (vault_id) on delete cascade,
    repository_id bytea not null check (octet_length(repository_id) = 32),
    body bytea not null check (octet_length(body) between 16 and 65536),
    body_digest bytea not null check (octet_length(body_digest) = 32),
    size_bytes bigint generated always as (octet_length(body)::bigint) stored,
    created_at timestamptz not null default statement_timestamp(),
    unique (vault_id, repository_id)
);

create table if not exists livesync_private.adaptive_v1_chunks (
    vault_id text not null,
    repository_id bytea not null check (octet_length(repository_id) = 32),
    chunk_key bytea not null check (octet_length(chunk_key) = 32),
    record_frame bytea not null check (octet_length(record_frame) between 20 and 67108772),
    frame_digest bytea not null check (octet_length(frame_digest) = 32),
    size_bytes bigint generated always as (octet_length(record_frame)::bigint) stored,
    created_at timestamptz not null default statement_timestamp(),
    primary key (vault_id, repository_id, chunk_key),
    foreign key (vault_id, repository_id)
        references livesync_private.adaptive_v1_manifests (vault_id, repository_id) on delete cascade
);

create table if not exists livesync_private.adaptive_v1_writers (
    vault_id text not null,
    repository_id bytea not null check (octet_length(repository_id) = 32),
    writer_stream_id bytea not null check (octet_length(writer_stream_id) = 32),
    descriptor_frame bytea not null check (octet_length(descriptor_frame) between 20 and 8388608),
    descriptor_digest bytea not null check (octet_length(descriptor_digest) = 32),
    size_bytes bigint generated always as (octet_length(descriptor_frame)::bigint) stored,
    created_at timestamptz not null default statement_timestamp(),
    primary key (vault_id, repository_id, writer_stream_id),
    foreign key (vault_id, repository_id)
        references livesync_private.adaptive_v1_manifests (vault_id, repository_id) on delete cascade
);

create table if not exists livesync_private.adaptive_v1_commits (
    vault_id text not null,
    repository_id bytea not null check (octet_length(repository_id) = 32),
    writer_stream_id bytea not null check (octet_length(writer_stream_id) = 32),
    sequence bigint not null check (sequence between 1 and 9223372036854775807),
    previous_commit_digest bytea null check (
        previous_commit_digest is null or octet_length(previous_commit_digest) = 32
    ),
    required_chunk_keys bytea[] not null,
    required_chunk_keys_digest bytea not null check (octet_length(required_chunk_keys_digest) = 32),
    metadata_digest bytea not null check (octet_length(metadata_digest) = 32),
    commit_digest bytea not null check (octet_length(commit_digest) = 32),
    envelope_digest bytea not null check (octet_length(envelope_digest) = 32),
    envelope bytea not null check (octet_length(envelope) between 292 and 67108864),
    size_bytes bigint generated always as (octet_length(envelope)::bigint) stored,
    created_at timestamptz not null default statement_timestamp(),
    primary key (vault_id, repository_id, writer_stream_id, sequence),
    foreign key (vault_id, repository_id, writer_stream_id)
        references livesync_private.adaptive_v1_writers (vault_id, repository_id, writer_stream_id) on delete cascade
);

alter table livesync_private.adaptive_vaults enable row level security;
alter table livesync_private.adaptive_v1_manifests enable row level security;
alter table livesync_private.adaptive_v1_chunks enable row level security;
alter table livesync_private.adaptive_v1_writers enable row level security;
alter table livesync_private.adaptive_v1_commits enable row level security;

create or replace function livesync_private.base64url_encode(payload bytea)
returns text
language sql
immutable
strict
security invoker
set search_path = pg_catalog
as $$
    select rtrim(translate(encode(payload, 'base64'), '+/', '-_'), '=');
$$;

create or replace function livesync_private.base64url_32(value text, label text)
returns bytea
language plpgsql
immutable
strict
security invoker
set search_path = pg_catalog
as $$
declare
    decoded_value bytea;
begin
    if value !~ '^[A-Za-z0-9_-]{43}$' then
        raise sqlstate 'PT400' using message = label || ' must be a 32-byte base64url value';
    end if;
    begin
        decoded_value := decode(translate(value, '-_', '+/') || '=', 'base64');
    exception when others then
        raise sqlstate 'PT400' using message = label || ' is not valid base64url';
    end;
    if octet_length(decoded_value) <> 32 then
        raise sqlstate 'PT400' using message = label || ' must decode to 32 bytes';
    end if;
    return decoded_value;
end
$$;

create or replace function livesync_private.request_headers()
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $$
    select coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb;
$$;

create or replace function livesync_private.current_vault_id()
returns text
language plpgsql
stable
security invoker
set search_path = pg_catalog, livesync_private
as $$
declare
    credential text;
    expected_digest bytea;
    requested_vault_id text;
begin
    requested_vault_id := nullif(livesync_private.request_headers() ->> 'x-livesync-vault-id', '');
    credential := nullif(livesync_private.request_headers() ->> 'x-livesync-vault-credential', '');
    if requested_vault_id is null or credential is null then
        raise sqlstate 'PT401' using message = 'A Vault ID and Vault credential are required';
    end if;
    if octet_length(requested_vault_id) > 128 or octet_length(credential) > 512 then
        raise sqlstate 'PT401' using message = 'The Vault credentials are invalid';
    end if;
    select adaptive_vaults.credential_digest
      into expected_digest
      from livesync_private.adaptive_vaults
     where adaptive_vaults.vault_id = requested_vault_id;
    if not found or expected_digest <> livesync_private.sha256(convert_to(credential, 'UTF8')) then
        raise sqlstate 'PT401' using message = 'The Vault credentials are invalid';
    end if;
    return requested_vault_id;
end
$$;

create or replace function livesync_private.current_repository_id()
returns bytea
language plpgsql
stable
security invoker
set search_path = pg_catalog, livesync_private
as $$
declare
    repository_id_value bytea;
    requested_repository_id bytea;
    vault_id_value text := livesync_private.current_vault_id();
begin
    requested_repository_id := livesync_private.base64url_32(
        coalesce(livesync_private.request_headers() ->> 'x-livesync-repository-id', ''),
        'X-LiveSync-Repository-ID'
    );
    select adaptive_v1_manifests.repository_id
      into repository_id_value
      from livesync_private.adaptive_v1_manifests
     where adaptive_v1_manifests.vault_id = vault_id_value;
    if not found then
        raise sqlstate 'PT409' using message = 'The Adaptive Journal manifest is missing';
    end if;
    if repository_id_value <> requested_repository_id then
        raise sqlstate 'PT409' using message = 'The Adaptive Journal repository ID does not match';
    end if;
    return repository_id_value;
end
$$;

create or replace function livesync_private.current_writer_stream_id()
returns bytea
language sql
stable
security invoker
set search_path = pg_catalog, livesync_private
as $$
    select livesync_private.base64url_32(
        coalesce(livesync_private.request_headers() ->> 'x-livesync-writer-stream-id', ''),
        'X-LiveSync-Writer-Stream-ID'
    );
$$;

create or replace function livesync_private.current_sequence()
returns bigint
language plpgsql
stable
security invoker
set search_path = pg_catalog, livesync_private
as $$
declare
    sequence_text text := nullif(livesync_private.request_headers() ->> 'x-livesync-sequence', '');
    sequence_value bigint;
begin
    if sequence_text is null or sequence_text !~ '^[1-9][0-9]{0,18}$' then
        raise sqlstate 'PT400' using message = 'X-LiveSync-Sequence must be a positive 63-bit integer';
    end if;
    begin
        sequence_value := sequence_text::bigint;
    exception when numeric_value_out_of_range then
        raise sqlstate 'PT400' using message = 'X-LiveSync-Sequence exceeds the positive 63-bit range';
    end;
    if sequence_value < 1 then
        raise sqlstate 'PT400' using message = 'X-LiveSync-Sequence must be positive';
    end if;
    return sequence_value;
end
$$;

create or replace function livesync_private.read_uint_be(payload bytea, zero_offset integer, width integer)
returns bigint
language plpgsql
immutable
strict
security invoker
set search_path = pg_catalog
as $$
declare
    byte_index integer := 0;
    result_value bigint := 0;
begin
    if zero_offset < 0 or width < 1 or width > 8 or octet_length(payload) < zero_offset + width then
        raise sqlstate 'PT400' using message = 'Adaptive Journal binary integer is truncated or invalid';
    end if;
    if width = 8 and get_byte(payload, zero_offset) > 127 then
        raise sqlstate 'PT400' using message = 'Adaptive Journal binary integer exceeds the signed 63-bit range';
    end if;
    while byte_index < width loop
        result_value := result_value * 256 + get_byte(payload, zero_offset + byte_index);
        byte_index := byte_index + 1;
    end loop;
    return result_value;
end
$$;

create or replace function livesync_private.uint_be(input_value bigint, width integer)
returns bytea
language plpgsql
immutable
strict
security invoker
set search_path = pg_catalog
as $$
declare
    byte_index integer;
    remaining_value bigint := input_value;
    result_value bytea;
begin
    if input_value < 0 or width < 1 or width > 8 then
        raise sqlstate 'PT400' using message = 'Adaptive Journal integer cannot be encoded';
    end if;
    result_value := decode(repeat('00', width), 'hex');
    byte_index := width - 1;
    while byte_index >= 0 loop
        result_value := set_byte(result_value, byte_index, (remaining_value % 256)::integer);
        remaining_value := remaining_value / 256;
        byte_index := byte_index - 1;
    end loop;
    if remaining_value <> 0 then
        raise sqlstate 'PT400' using message = 'Adaptive Journal integer does not fit its field';
    end if;
    return result_value;
end
$$;

create or replace function livesync_private.validate_record_frame(
    frame bytea,
    expected_kind integer,
    maximum_bytes integer
)
returns void
language plpgsql
immutable
strict
security invoker
set search_path = pg_catalog, livesync_private
as $$
declare
    public_header_length bigint;
    payload_length bigint;
begin
    if octet_length(frame) < 20 or octet_length(frame) > maximum_bytes then
        raise sqlstate 'PT400' using message = 'Adaptive Journal record frame is outside its byte limit';
    end if;
    if substring(frame from 1 for 4) <> decode('4c534152', 'hex')
       or get_byte(frame, 4) <> 1
       or get_byte(frame, 5) <> expected_kind then
        raise sqlstate 'PT400' using message = 'Adaptive Journal record frame kind or version does not match';
    end if;
    if livesync_private.read_uint_be(frame, 6, 2) not in (0, 1) then
        raise sqlstate 'PT400' using message = 'Adaptive Journal record frame flags are unsupported';
    end if;
    public_header_length := livesync_private.read_uint_be(frame, 8, 4);
    payload_length := livesync_private.read_uint_be(frame, 12, 8);
    if 20 + public_header_length + payload_length <> octet_length(frame) then
        raise sqlstate 'PT400' using message = 'Adaptive Journal record frame length does not match its bytes';
    end if;
end
$$;

create or replace function livesync_private.validate_batch_request(payload bytea)
returns table (entry_count integer, operation integer)
language plpgsql
immutable
strict
security invoker
set search_path = pg_catalog, livesync_private
as $$
declare
    count_value bigint;
    operation_value integer;
begin
    if octet_length(payload) < 20 or octet_length(payload) > 67108864 then
        raise sqlstate 'PT400' using message = 'Adaptive Journal batch is outside its byte limit';
    end if;
    if substring(payload from 1 for 4) <> decode('4c534142', 'hex') or get_byte(payload, 4) <> 1 then
        raise sqlstate 'PT400' using message = 'Adaptive Journal batch magic or version does not match';
    end if;
    operation_value := get_byte(payload, 5);
    if operation_value not in (1, 2, 3) or livesync_private.read_uint_be(payload, 6, 2) <> 0 then
        raise sqlstate 'PT400' using message = 'Adaptive Journal batch operation or flags are unsupported';
    end if;
    count_value := livesync_private.read_uint_be(payload, 8, 4);
    if count_value > 4096 then
        raise sqlstate 'PT400' using message = 'Adaptive Journal batch contains too many entries';
    end if;
    if livesync_private.read_uint_be(payload, 12, 8) <> octet_length(payload) then
        raise sqlstate 'PT400' using message = 'Adaptive Journal batch total length does not match its bytes';
    end if;
    return query select count_value::integer, operation_value;
end
$$;

create or replace function livesync_private.make_batch_response(
    operation integer,
    entry_count integer,
    response_body bytea
)
returns bytea
language plpgsql
immutable
strict
security invoker
set search_path = pg_catalog, livesync_private
as $$
declare
    total_length bigint := 20 + octet_length(response_body);
begin
    if operation not in (1, 2, 3) or entry_count < 0 or entry_count > 4096 or total_length > 67108864 then
        raise sqlstate 'PT413' using message = 'Adaptive Journal batch response exceeds its limit';
    end if;
    return decode('4c534142', 'hex')
        || livesync_private.uint_be(1, 1)
        || livesync_private.uint_be(operation, 1)
        || livesync_private.uint_be(1, 2)
        || livesync_private.uint_be(entry_count, 4)
        || livesync_private.uint_be(total_length, 8)
        || response_body;
end
$$;

create or replace function livesync_private.provision_adaptive_vault()
returns table (vault_id text, vault_credential text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, livesync_private
as $$
declare
    generated_credential text;
    generated_vault_id text;
begin
    loop
        generated_vault_id := livesync_private.base64url_encode(livesync_private.random_bytes(16));
        generated_credential := livesync_private.base64url_encode(livesync_private.random_bytes(32));
        begin
            insert into livesync_private.adaptive_vaults (vault_id, credential_digest)
            values (
                generated_vault_id,
                livesync_private.sha256(convert_to(generated_credential, 'UTF8'))
            );
            return query select generated_vault_id, generated_credential;
            return;
        exception when unique_violation then
            -- A random identifier collision is retried without exposing partial credentials.
        end;
    end loop;
end
$$;

create or replace function livesync_private.revoke_adaptive_vault(target_vault_id text)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, livesync_private
as $$
declare
    deleted_count integer;
begin
    delete from livesync_private.adaptive_vaults where adaptive_vaults.vault_id = target_vault_id;
    get diagnostics deleted_count = row_count;
    return deleted_count = 1;
end
$$;

create or replace function livesync_api.livesync_adaptive_manifest_create(bytea)
returns integer
language plpgsql
volatile
security definer
set search_path = pg_catalog, livesync_private
as $$
declare
    inserted_count integer;
    manifest jsonb;
    repository_id_value bytea;
    vault_id_value text := livesync_private.current_vault_id();
begin
    if octet_length($1) < 16 or octet_length($1) > 65536 then
        raise sqlstate 'PT400' using message = 'Adaptive Journal manifest is outside its byte limit';
    end if;
    begin
        manifest := convert_from($1, 'UTF8')::jsonb;
    exception when others then
        raise sqlstate 'PT400' using message = 'Adaptive Journal manifest is not valid UTF-8 JSON';
    end;
    if manifest ->> 'format' <> 'adaptive-journal'
       or manifest ->> 'formatVersion' <> '1'
       or manifest ->> 'objectLayout' <> 'commit-bundle-v1' then
        raise sqlstate 'PT400' using message = 'Adaptive Journal manifest format does not match v1';
    end if;
    repository_id_value := livesync_private.base64url_32(
        coalesce(manifest ->> 'repositoryId', ''),
        'Manifest repositoryId'
    );
    insert into livesync_private.adaptive_v1_manifests (
        vault_id, repository_id, body, body_digest
    ) values (
        vault_id_value, repository_id_value, $1, livesync_private.sha256($1)
    ) on conflict (vault_id) do nothing;
    get diagnostics inserted_count = row_count;
    return case when inserted_count = 1 then 0 else 1 end;
end
$$;

create or replace function livesync_api.livesync_adaptive_manifest_get()
returns livesync_api."application/octet-stream"
language plpgsql
stable
security definer
set search_path = pg_catalog, livesync_private, livesync_api
as $$
declare
    payload bytea;
begin
    select adaptive_v1_manifests.body
      into payload
      from livesync_private.adaptive_v1_manifests
     where adaptive_v1_manifests.vault_id = livesync_private.current_vault_id();
    if not found then
        raise sqlstate 'PT404' using message = 'Adaptive Journal manifest not found';
    end if;
    return payload::livesync_api."application/octet-stream";
end
$$;

create or replace function livesync_api.livesync_adaptive_binary_echo(bytea)
returns livesync_api."application/octet-stream"
language plpgsql
stable
security definer
set search_path = pg_catalog, livesync_private, livesync_api
as $$
begin
    perform livesync_private.current_vault_id();
    if octet_length($1) > 67108864 then
        raise sqlstate 'PT413' using message = 'Binary probe exceeds the server limit';
    end if;
    return $1::livesync_api."application/octet-stream";
end
$$;

create or replace function livesync_api.livesync_adaptive_chunks(bytea)
returns livesync_api."application/octet-stream"
language plpgsql
volatile
security definer
set search_path = pg_catalog, livesync_private, livesync_api
as $$
declare
    chunk_keys bytea[] := array[]::bytea[];
    entry_count integer;
    entry_index integer := 0;
    frame_digests bytea[] := array[]::bytea[];
    frame_length bigint;
    frames bytea[] := array[]::bytea[];
    offset_value integer := 20;
    operation_value integer;
    repository_id_value bytea := livesync_private.current_repository_id();
    response_body bytea;
    response_bytes bigint;
    vault_id_value text := livesync_private.current_vault_id();
begin
    select validated.entry_count, validated.operation
      into entry_count, operation_value
      from livesync_private.validate_batch_request($1) validated;
    while entry_index < entry_count loop
        if offset_value + 32 > octet_length($1) then
            raise sqlstate 'PT400' using message = 'Adaptive Journal Chunk entry is truncated';
        end if;
        chunk_keys := array_append(chunk_keys, substring($1 from offset_value + 1 for 32));
        offset_value := offset_value + 32;
        if operation_value = 3 then
            if offset_value + 40 > octet_length($1) then
                raise sqlstate 'PT400' using message = 'Adaptive Journal Chunk PUT entry is truncated';
            end if;
            frame_digests := array_append(frame_digests, substring($1 from offset_value + 1 for 32));
            offset_value := offset_value + 32;
            frame_length := livesync_private.read_uint_be($1, offset_value, 8);
            offset_value := offset_value + 8;
            if frame_length < 20 or frame_length > 67108772 or offset_value + frame_length > octet_length($1) then
                raise sqlstate 'PT400' using message = 'Adaptive Journal Chunk frame is outside its limit';
            end if;
            frames := array_append(frames, substring($1 from offset_value + 1 for frame_length::integer));
            offset_value := offset_value + frame_length::integer;
        end if;
        entry_index := entry_index + 1;
    end loop;
    if offset_value <> octet_length($1) then
        raise sqlstate 'PT400' using message = 'Adaptive Journal Chunk batch contains trailing bytes';
    end if;
    if (select count(distinct encode(key_value, 'hex')) from unnest(chunk_keys) key_value) <> entry_count then
        raise sqlstate 'PT400' using message = 'Adaptive Journal Chunk batch contains duplicate keys';
    end if;

    if operation_value = 1 then
        select coalesce(
            string_agg(
                case when stored.chunk_key is null then decode('00', 'hex') else decode('01', 'hex') end,
                ''::bytea order by requested.ordinal
            ),
            ''::bytea
        ) into response_body
          from unnest(chunk_keys) with ordinality requested(chunk_key, ordinal)
          left join livesync_private.adaptive_v1_chunks stored
            on stored.vault_id = vault_id_value
           and stored.repository_id = repository_id_value
           and stored.chunk_key = requested.chunk_key;
    elsif operation_value = 2 then
        select 20 + coalesce(sum(
            case when stored.chunk_key is null then 1::bigint
                 else 41::bigint + octet_length(stored.record_frame)::bigint end
        ), 0)
          into response_bytes
          from unnest(chunk_keys) requested(chunk_key)
          left join livesync_private.adaptive_v1_chunks stored
            on stored.vault_id = vault_id_value
           and stored.repository_id = repository_id_value
           and stored.chunk_key = requested.chunk_key;
        if response_bytes > 67108864 or (response_bytes > 33554432 and entry_count > 1) then
            raise sqlstate 'PT413' using message = 'Adaptive Journal Chunk GET response exceeds its preferred limit';
        end if;
        select coalesce(
            string_agg(
                case when stored.chunk_key is null then decode('00', 'hex') else
                    decode('01', 'hex') || stored.frame_digest
                    || livesync_private.uint_be(octet_length(stored.record_frame), 8)
                    || stored.record_frame
                end,
                ''::bytea order by requested.ordinal
            ),
            ''::bytea
        ) into response_body
          from unnest(chunk_keys) with ordinality requested(chunk_key, ordinal)
          left join livesync_private.adaptive_v1_chunks stored
            on stored.vault_id = vault_id_value
           and stored.repository_id = repository_id_value
           and stored.chunk_key = requested.chunk_key;
    else
        for entry_index in 1..entry_count loop
            perform livesync_private.validate_record_frame(frames[entry_index], 1, 67108772);
            if livesync_private.sha256(frames[entry_index]) <> frame_digests[entry_index] then
                raise sqlstate 'PT400' using message = 'Adaptive Journal Chunk frame digest does not match';
            end if;
        end loop;
        with input_rows as (
            select input.chunk_key, input.frame_digest, input.record_frame, input.ordinal
              from unnest(chunk_keys, frame_digests, frames) with ordinality
                   input(chunk_key, frame_digest, record_frame, ordinal)
        ), inserted_rows as (
            insert into livesync_private.adaptive_v1_chunks (
                vault_id, repository_id, chunk_key, record_frame, frame_digest
            )
            select vault_id_value, repository_id_value, input_rows.chunk_key,
                   input_rows.record_frame, input_rows.frame_digest
              from input_rows
             order by input_rows.ordinal
            on conflict (vault_id, repository_id, chunk_key) do nothing
            returning chunk_key
        )
        select coalesce(
            string_agg(
                case
                    when inserted_rows.chunk_key is not null then decode('00', 'hex')
                    when stored.frame_digest = input_rows.frame_digest
                     and stored.record_frame = input_rows.record_frame then decode('01', 'hex')
                    else decode('02', 'hex')
                end,
                ''::bytea order by input_rows.ordinal
            ),
            ''::bytea
        ) into response_body
          from input_rows
          left join livesync_private.adaptive_v1_chunks stored
            on stored.vault_id = vault_id_value
           and stored.repository_id = repository_id_value
           and stored.chunk_key = input_rows.chunk_key
          left join inserted_rows on inserted_rows.chunk_key = input_rows.chunk_key;
    end if;
    return livesync_private.make_batch_response(operation_value, entry_count, response_body)
        ::livesync_api."application/octet-stream";
end
$$;

create or replace function livesync_api.livesync_adaptive_writer_create(bytea)
returns integer
language plpgsql
volatile
security definer
set search_path = pg_catalog, livesync_private
as $$
declare
    descriptor_digest_value bytea := livesync_private.sha256($1);
    existing_frame bytea;
    inserted_count integer;
    repository_id_value bytea := livesync_private.current_repository_id();
    vault_id_value text := livesync_private.current_vault_id();
    writer_stream_id_value bytea := livesync_private.current_writer_stream_id();
begin
    perform livesync_private.validate_record_frame($1, 6, 8388608);
    insert into livesync_private.adaptive_v1_writers (
        vault_id, repository_id, writer_stream_id, descriptor_frame, descriptor_digest
    ) values (
        vault_id_value, repository_id_value, writer_stream_id_value, $1, descriptor_digest_value
    ) on conflict (vault_id, repository_id, writer_stream_id) do nothing;
    get diagnostics inserted_count = row_count;
    if inserted_count = 1 then return 0; end if;
    select adaptive_v1_writers.descriptor_frame
      into existing_frame
      from livesync_private.adaptive_v1_writers
     where vault_id = vault_id_value
       and repository_id = repository_id_value
       and writer_stream_id = writer_stream_id_value;
    return case when existing_frame = $1 then 1 else 2 end;
end
$$;

create or replace function livesync_api.livesync_adaptive_writer_get()
returns livesync_api."application/octet-stream"
language plpgsql
stable
security definer
set search_path = pg_catalog, livesync_private, livesync_api
as $$
declare
    payload bytea;
begin
    select descriptor_frame
      into payload
      from livesync_private.adaptive_v1_writers
     where vault_id = livesync_private.current_vault_id()
       and repository_id = livesync_private.current_repository_id()
       and writer_stream_id = livesync_private.current_writer_stream_id();
    if not found then
        raise sqlstate 'PT404' using message = 'Adaptive Journal Writer not found';
    end if;
    return payload::livesync_api."application/octet-stream";
end
$$;

create or replace function livesync_api.livesync_adaptive_writer_list()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, livesync_private
as $$
    select coalesce(
        jsonb_agg(livesync_private.base64url_encode(writer_stream_id) order by writer_stream_id),
        '[]'::jsonb
    )
      from livesync_private.adaptive_v1_writers
     where vault_id = livesync_private.current_vault_id()
       and repository_id = livesync_private.current_repository_id();
$$;

create or replace function livesync_api.livesync_adaptive_commit_create(bytea)
returns integer
language plpgsql
volatile
security definer
set search_path = pg_catalog, livesync_private
as $$
declare
    commit_digest_value bytea;
    commit_frame bytea;
    commit_frame_length bigint;
    envelope_repository_id bytea;
    envelope_writer_stream_id bytea;
    existing_envelope bytea;
    metadata_digest_value bytea;
    metadata_frame bytea;
    metadata_frame_length bigint;
    offset_value integer;
    predecessor_digest bytea;
    previous_commit_digest_value bytea;
    previous_present integer;
    previous_required_key bytea;
    repository_id_value bytea := livesync_private.current_repository_id();
    required_chunk_key bytea;
    required_chunk_key_bytes bytea := ''::bytea;
    required_chunk_key_count bigint;
    required_chunk_keys bytea[] := array[]::bytea[];
    required_chunk_keys_digest_value bytea;
    required_present_count bigint;
    sequence_value bigint;
    total_expected bigint;
    vault_id_value text := livesync_private.current_vault_id();
begin
    if octet_length($1) < 292 or octet_length($1) > 67108864
       or substring($1 from 1 for 4) <> decode('4c534143', 'hex')
       or get_byte($1, 4) <> 2
       or get_byte($1, 5) <> 0
       or livesync_private.read_uint_be($1, 6, 2) <> 0
       or livesync_private.read_uint_be($1, 8, 8) <> octet_length($1) then
        raise sqlstate 'PT400' using message = 'Adaptive Journal Commit Bundle header is invalid';
    end if;
    envelope_repository_id := substring($1 from 17 for 32);
    envelope_writer_stream_id := substring($1 from 49 for 32);
    sequence_value := livesync_private.read_uint_be($1, 80, 8);
    if envelope_repository_id <> repository_id_value or sequence_value < 1 then
        raise sqlstate 'PT409' using message = 'Adaptive Journal Commit Bundle route does not match';
    end if;
    previous_present := get_byte($1, 88);
    if substring($1 from 90 for 7) <> decode(repeat('00', 7), 'hex') then
        raise sqlstate 'PT400' using message = 'Adaptive Journal Commit predecessor reserved bytes are non-zero';
    end if;
    previous_commit_digest_value := substring($1 from 97 for 32);
    if sequence_value = 1 then
        if previous_present <> 0 or previous_commit_digest_value <> decode(repeat('00', 32), 'hex') then
            raise sqlstate 'PT409' using message = 'The first Adaptive Journal Commit must not have a predecessor';
        end if;
        previous_commit_digest_value := null;
    elsif previous_present <> 1 then
        raise sqlstate 'PT409' using message = 'Adaptive Journal Commit predecessor is missing';
    end if;
    required_chunk_key_count := livesync_private.read_uint_be($1, 128, 4);
    if required_chunk_key_count > 4096 then
        raise sqlstate 'PT400' using message = 'Adaptive Journal Commit requires too many Chunks';
    end if;
    required_chunk_keys_digest_value := substring($1 from 133 for 32);
    if substring($1 from 165 for 40)
       <> envelope_writer_stream_id || livesync_private.uint_be(sequence_value, 8) then
        raise sqlstate 'PT400' using message = 'Adaptive Journal Metadata logical key does not match';
    end if;
    metadata_digest_value := substring($1 from 205 for 32);
    commit_frame_length := livesync_private.read_uint_be($1, 236, 8);
    metadata_frame_length := livesync_private.read_uint_be($1, 244, 8);
    if commit_frame_length < 1 or commit_frame_length > 8388608
       or metadata_frame_length < 1 or metadata_frame_length > 16777216 then
        raise sqlstate 'PT400' using message = 'Adaptive Journal Commit or Metadata frame exceeds its limit';
    end if;
    if livesync_private.read_uint_be($1, 252, 8) <> 0
       or substring($1 from 261 for 32) <> decode(repeat('00', 32), 'hex') then
        raise sqlstate 'PT400' using message = 'Native PostgREST Commit Bundles cannot contain an inline Pack';
    end if;
    total_expected := 292 + required_chunk_key_count * 32 + commit_frame_length + metadata_frame_length;
    if total_expected <> octet_length($1) then
        raise sqlstate 'PT400' using message = 'Adaptive Journal Commit Bundle sections do not match its length';
    end if;
    offset_value := 292;
    while cardinality(required_chunk_keys) < required_chunk_key_count loop
        required_chunk_key := substring($1 from offset_value + 1 for 32);
        if previous_required_key is not null and previous_required_key >= required_chunk_key then
            raise sqlstate 'PT400' using message = 'Adaptive Journal required Chunk keys are not strictly ordered';
        end if;
        required_chunk_keys := array_append(required_chunk_keys, required_chunk_key);
        required_chunk_key_bytes := required_chunk_key_bytes || required_chunk_key;
        previous_required_key := required_chunk_key;
        offset_value := offset_value + 32;
    end loop;
    if livesync_private.sha256(required_chunk_key_bytes) <> required_chunk_keys_digest_value then
        raise sqlstate 'PT400' using message = 'Adaptive Journal required Chunk key digest does not match';
    end if;
    commit_frame := substring($1 from offset_value + 1 for commit_frame_length::integer);
    offset_value := offset_value + commit_frame_length::integer;
    metadata_frame := substring($1 from offset_value + 1 for metadata_frame_length::integer);
    perform livesync_private.validate_record_frame(commit_frame, 7, 8388608);
    perform livesync_private.validate_record_frame(metadata_frame, 3, 16777216);
    if livesync_private.sha256(metadata_frame) <> metadata_digest_value then
        raise sqlstate 'PT400' using message = 'Adaptive Journal Metadata digest does not match';
    end if;
    commit_digest_value := livesync_private.sha256(commit_frame);

    perform 1
      from livesync_private.adaptive_v1_writers
     where vault_id = vault_id_value
       and repository_id = repository_id_value
       and writer_stream_id = envelope_writer_stream_id
     for update;
    if not found then
        raise sqlstate 'PT409' using message = 'Adaptive Journal Writer must be registered before Commit';
    end if;
    select adaptive_v1_commits.envelope
      into existing_envelope
      from livesync_private.adaptive_v1_commits
     where vault_id = vault_id_value
       and repository_id = repository_id_value
       and writer_stream_id = envelope_writer_stream_id
       and sequence = sequence_value;
    if found then
        return case when existing_envelope = $1 then 1 else 2 end;
    end if;
    if sequence_value > 1 then
        select adaptive_v1_commits.commit_digest
          into predecessor_digest
          from livesync_private.adaptive_v1_commits
         where vault_id = vault_id_value
           and repository_id = repository_id_value
           and writer_stream_id = envelope_writer_stream_id
           and sequence = sequence_value - 1;
        if not found or predecessor_digest <> previous_commit_digest_value then
            raise sqlstate 'PT409' using message = 'Adaptive Journal Commit predecessor does not match';
        end if;
    end if;
    select count(*)
      into required_present_count
      from unnest(required_chunk_keys) required(chunk_key)
      join livesync_private.adaptive_v1_chunks stored
        on stored.vault_id = vault_id_value
       and stored.repository_id = repository_id_value
       and stored.chunk_key = required.chunk_key;
    if required_present_count <> required_chunk_key_count then
        raise sqlstate 'PT409' using message = 'Adaptive Journal Commit references missing Chunks';
    end if;
    insert into livesync_private.adaptive_v1_commits (
        vault_id, repository_id, writer_stream_id, sequence, previous_commit_digest,
        required_chunk_keys, required_chunk_keys_digest, metadata_digest, commit_digest,
        envelope_digest, envelope
    ) values (
        vault_id_value, repository_id_value, envelope_writer_stream_id, sequence_value,
        previous_commit_digest_value, required_chunk_keys, required_chunk_keys_digest_value,
        metadata_digest_value, commit_digest_value, livesync_private.sha256($1), $1
    );
    return 0;
end
$$;

create or replace function livesync_api.livesync_adaptive_commit_get()
returns livesync_api."application/octet-stream"
language plpgsql
stable
security definer
set search_path = pg_catalog, livesync_private, livesync_api
as $$
declare
    payload bytea;
begin
    select envelope
      into payload
      from livesync_private.adaptive_v1_commits
     where vault_id = livesync_private.current_vault_id()
       and repository_id = livesync_private.current_repository_id()
       and writer_stream_id = livesync_private.current_writer_stream_id()
       and sequence = livesync_private.current_sequence();
    if not found then
        raise sqlstate 'PT404' using message = 'Adaptive Journal Commit not found';
    end if;
    return payload::livesync_api."application/octet-stream";
end
$$;

create or replace function livesync_api.livesync_adaptive_commit_list(
    after_sequence bigint default 0,
    max_rows integer default 1000
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, livesync_private
as $$
declare
    result_value jsonb;
begin
    if after_sequence < 0 or max_rows < 1 or max_rows > 10000 then
        raise sqlstate 'PT400' using message = 'Adaptive Journal Commit list parameters are invalid';
    end if;
    select coalesce(jsonb_agg(sequence_text order by sequence_value), '[]'::jsonb)
      into result_value
      from (
          select sequence as sequence_value, sequence::text as sequence_text
            from livesync_private.adaptive_v1_commits
           where vault_id = livesync_private.current_vault_id()
             and repository_id = livesync_private.current_repository_id()
             and writer_stream_id = livesync_private.current_writer_stream_id()
             and sequence > after_sequence
           order by sequence
           limit max_rows
      ) commit_rows;
    return result_value;
end
$$;

create or replace function livesync_api.livesync_adaptive_reset()
returns bigint
language plpgsql
volatile
security definer
set search_path = pg_catalog, livesync_private
as $$
declare
    deleted_count bigint;
begin
    delete from livesync_private.adaptive_v1_manifests
     where vault_id = livesync_private.current_vault_id();
    get diagnostics deleted_count = row_count;
    return deleted_count;
end
$$;

create or replace function livesync_api.livesync_adaptive_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, livesync_private
as $$
declare
    result_value jsonb;
    vault_id_value text := livesync_private.current_vault_id();
begin
    select jsonb_build_object(
        'estimated_size',
        coalesce((select sum(size_bytes) from livesync_private.adaptive_v1_manifests where vault_id = vault_id_value), 0)
        + coalesce((select sum(size_bytes) from livesync_private.adaptive_v1_chunks where vault_id = vault_id_value), 0)
        + coalesce((select sum(size_bytes) from livesync_private.adaptive_v1_writers where vault_id = vault_id_value), 0)
        + coalesce((select sum(size_bytes) from livesync_private.adaptive_v1_commits where vault_id = vault_id_value), 0)
    ) into result_value;
    return result_value;
end
$$;

create or replace function livesync_api.livesync_adaptive_capabilities()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, livesync_private
as $$
begin
    perform livesync_private.current_vault_id();
    return jsonb_build_object(
        'format_version', 1,
        'capabilities', jsonb_build_array(
            'binary-fidelity',
            'complete-listing',
            'conditional-create',
            'delete-visibility',
            'read-after-write',
            'native-batch-chunk-cas',
            'server-side-immutable-cas',
            'transactional-metadata-commit',
            'writer-discovery',
            'commit-discovery',
            'transactional-vault-reset'
        )
    );
end
$$;

revoke all on schema livesync_private from public;
revoke all on livesync_private.adaptive_vaults from public;
revoke all on livesync_private.adaptive_v1_manifests from public;
revoke all on livesync_private.adaptive_v1_chunks from public;
revoke all on livesync_private.adaptive_v1_writers from public;
revoke all on livesync_private.adaptive_v1_commits from public;
revoke all on all functions in schema livesync_private from public;

grant usage on schema livesync_api to public;
grant execute on function livesync_api.livesync_adaptive_manifest_create(bytea) to public;
grant execute on function livesync_api.livesync_adaptive_manifest_get() to public;
grant execute on function livesync_api.livesync_adaptive_binary_echo(bytea) to public;
grant execute on function livesync_api.livesync_adaptive_chunks(bytea) to public;
grant execute on function livesync_api.livesync_adaptive_writer_create(bytea) to public;
grant execute on function livesync_api.livesync_adaptive_writer_get() to public;
grant execute on function livesync_api.livesync_adaptive_writer_list() to public;
grant execute on function livesync_api.livesync_adaptive_commit_create(bytea) to public;
grant execute on function livesync_api.livesync_adaptive_commit_get() to public;
grant execute on function livesync_api.livesync_adaptive_commit_list(bigint, integer) to public;
grant execute on function livesync_api.livesync_adaptive_reset() to public;
grant execute on function livesync_api.livesync_adaptive_status() to public;
grant execute on function livesync_api.livesync_adaptive_capabilities() to public;

commit;
