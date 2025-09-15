CREATE SCHEMA IF NOT EXISTS extranet;

DROP VIEW IF EXISTS extranet."ExtranetSession";

CREATE VIEW extranet."ExtranetSession" AS
SELECT
  id,
  "partnerId",
  token,
  "expiresAt",
  "createdAt",
  "revokedAt"
FROM public."ExtranetSession";
