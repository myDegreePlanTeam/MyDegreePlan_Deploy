-- Runs once, when the database volume is first created (mounted into the
-- supabase/postgres image's init directory). Gives the two service roles the
-- per-install password from .env instead of the image's well-known default.
\set pgpass `echo "$POSTGRES_PASSWORD"`

ALTER USER authenticator       WITH PASSWORD :'pgpass';
ALTER USER supabase_auth_admin WITH PASSWORD :'pgpass';
