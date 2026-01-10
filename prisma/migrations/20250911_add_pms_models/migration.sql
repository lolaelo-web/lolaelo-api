-- PMS models (idempotent) - extranet schema
CREATE SCHEMA IF NOT EXISTS extranet;

CREATE TABLE IF NOT EXISTS extranet."PmsConnection" (
  "id" SERIAL PRIMARY KEY,
  "partnerId" INTEGER NOT NULL REFERENCES extranet."Partner"("id") ON DELETE CASCADE,
  "provider" TEXT NOT NULL,
  "mode" TEXT NOT NULL DEFAULT 'mock',
  "status" TEXT NOT NULL DEFAULT 'TESTING',
  "scope" TEXT,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "tokenExpiresAt" TIMESTAMPTZ,
  "lastSyncAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "PmsConnection_partner_provider_unique" UNIQUE ("partnerId","provider")
);

CREATE TABLE IF NOT EXISTS extranet."PmsMapping" (
  "id" SERIAL PRIMARY KEY,
  "pmsConnectionId" INTEGER NOT NULL REFERENCES extranet."PmsConnection"("id") ON DELETE CASCADE,
  "remoteRoomId" TEXT NOT NULL,
  "remoteRatePlanId" TEXT,
  "localRoomTypeId" INTEGER REFERENCES extranet."RoomType"("id") ON DELETE SET NULL,
  "localRatePlanId" INTEGER REFERENCES extranet."RatePlan"("id") ON DELETE SET NULL,
  "currency" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS extranet."SyncLog" (
  "id" SERIAL PRIMARY KEY,
  "pmsConnectionId" INTEGER NOT NULL REFERENCES extranet."PmsConnection"("id") ON DELETE CASCADE,
  "type" TEXT NOT NULL,     -- AUTH|AVAILABILITY|RATES|MAPPINGS...
  "status" TEXT NOT NULL,   -- SUCCESS|ERROR
  "message" TEXT,
  "startedAt" TIMESTAMPTZ,
  "finishedAt" TIMESTAMPTZ,
  "durationMs" INTEGER,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
