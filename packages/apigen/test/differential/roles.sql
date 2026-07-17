-- Roles for the PostgREST differential harness.
--
-- The differential compares query translation and the HTTP response envelope,
-- NOT authorization: apigen mounts these relations publicly and PostgREST serves
-- them through `anon` with blanket grants and no RLS. Policy/RLS parity is covered
-- separately by the hermetic features.test.ts / matrix.test.ts suites.

create role anon nologin;
create role authenticator noinherit login password 'authenticator_pw';
grant anon to authenticator;

grant usage on schema public to anon;
grant select, insert, update, delete on all tables in schema public to anon;
grant usage, select on all sequences in schema public to anon;
