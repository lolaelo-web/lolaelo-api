-- Ensure schema exists
CREATE SCHEMA IF NOT EXISTS extranet;

-- If a TABLE exists with this name, rename it once (no-op if not a table)
DO $$
DECLARE obj_kind char;
BEGIN
  SELECT c.relkind INTO obj_kind
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'extranet' AND c.relname = 'ExtranetSession' LIMIT 1;

  IF obj_kind = 'r' THEN
    EXECUTE 'ALTER TABLE extranet."ExtranetSession" RENAME TO "ExtranetSession_bak"';
  END IF;
END $$;

-- Create or replace the compatibility VIEW pointing to the canonical public table
CREATE OR REPLACE VIEW extranet."ExtranetSession" AS
SELECT
  id,
  "partnerId",
  token,
  "expiresAt",
  "createdAt",
  "revokedAt"
FROM public."ExtranetSession";
