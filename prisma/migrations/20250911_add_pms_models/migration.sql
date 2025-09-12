-- PMS models (idempotent)
CREATE TABLE IF NOT EXISTS "PmsConnection" (
  "id" SERIAL PRIMARY KEY,
  "partnerId" INTEGER NOT NULL REFERENCES "Partner"("id") ON DELETE CASCADE,
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

CREATE TABLE IF NOT EXISTS "PmsMapping" (
  "id" SERIAL PRIMARY KEY,
  "pmsConnectionId" INTEGER NOT NULL REFERENCES "PmsConnection"("id") ON DELETE CASCADE,
  "remoteRoomId" TEXT NOT NULL,
  "remoteRatePlanId" TEXT,
  "localRoomTypeId" INTEGER REFERENCES "RoomType"("id") ON DELETE SET NULL,
  "localRatePlanId" INTEGER REFERENCES "RatePlan"("id") ON DELETE SET NULL,
  "currency" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "SyncLog" (
  "id" SERIAL PRIMARY KEY,
  "pmsConnectionId" INTEGER NOT NULL REFERENCES "PmsConnection"("id") ON DELETE CASCADE,
  "type" TEXT NOT NULL,     -- AUTH|AVAILABILITY|RATES|MAPPINGS...
  "status" TEXT NOT NULL,   -- SUCCESS|ERROR
  "message" TEXT,
  "startedAt" TIMESTAMPTZ,
  "finishedAt" TIMESTAMPTZ,
  "durationMs" INTEGER,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);