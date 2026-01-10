-- Ensure schema exists
CREATE SCHEMA IF NOT EXISTS extranet;

-- Ensure ExtranetSession exists in extranet (shadow-safe, extranet-only)
CREATE TABLE IF NOT EXISTS extranet."ExtranetSession" (
  id SERIAL PRIMARY KEY,
  "partnerId" INTEGER,
  token TEXT,
  "expiresAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ,
  "revokedAt" TIMESTAMPTZ
);
