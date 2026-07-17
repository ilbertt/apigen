-- This example is about exposing Postgres *functions* over HTTP, so the functions
-- are the star and the single table exists only to give a couple of them something
-- to read. apigen introspects every function in `public` into the generated
-- `functions` catalog; you choose which to expose with `.use(func(...))`.

create table articles (
  id bigint generated always as identity primary key,
  slug text not null unique,
  title text not null,
  body text not null,
  published boolean not null default false
);

-- Pure and public. `excited` has a default, so callers may omit it — apigen binds
-- only the arguments present in the request body and lets the rest fall to their
-- defaults.
create function greet(name text, excited boolean default false) returns text
  language sql immutable as $$
    select 'Hello, ' || name || case when excited then '!' else '.' end
  $$;

-- Set-returning: `select * from search_articles(...)` surfaces one JSON object per
-- row. A TABLE(...) return type names the columns.
create function search_articles(query text)
  returns table (slug text, title text)
  language sql stable as $$
    select slug, title
    from articles
    where published and title ilike '%' || query || '%'
    order by title
  $$;

-- No arguments: call it with an empty POST body.
create function server_time() returns timestamptz
  language sql stable as $$ select now() $$;

-- Side-effecting, admin-only. A function's authorization is a coarse gate — "may
-- this caller run it at all" — which is exactly right for an all-or-nothing action
-- like publishing. Row-level rules belong on relations (or inside the function).
create function publish_article(article_slug text) returns articles
  language sql as $$
    update articles set published = true where slug = article_slug
    returning *
  $$;
