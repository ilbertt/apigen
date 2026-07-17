-- The video bytes live in Postgres large objects (pg_largeobject). This table keeps
-- only each video's metadata plus its large-object id (`loid`) — there is no bytea
-- column; the payload is read straight out of the large object.
create table videos (
  id bigint generated always as identity primary key,
  title text not null,
  content_type text not null,
  loid oid not null,
  byte_size bigint not null
);

-- The byte-slicing is done *in the database*. Given a video id and a window, this
-- function clamps the window to the file's bounds and reads that slice out of the
-- large object with lo_get, returning the bytes plus the numbers the HTTP layer needs
-- for its Content-Length / Content-Range headers. The afterExecute hook calls it once
-- per request; range_length null means "to the end of the file".
create function video_chunk(id bigint, range_start bigint default 0, range_length int default null)
returns table (content_type text, total_size int, chunk_start int, chunk_length int, data bytea)
language sql stable as $$
  with v as (
    select content_type, byte_size, loid
    from videos
    where videos.id = video_chunk.id
  ),
  bounds as (
    select
      v.content_type,
      v.byte_size::int as total_size,
      greatest(range_start, 0)::int as chunk_start,
      greatest(
        0,
        least(
          coalesce(range_length, v.byte_size::int),
          (v.byte_size - greatest(range_start, 0))::int
        )
      ) as chunk_length,
      v.loid
    from v
  )
  select
    b.content_type,
    b.total_size,
    b.chunk_start,
    b.chunk_length,
    lo_get(b.loid, b.chunk_start, b.chunk_length)
  from bounds b
$$;
