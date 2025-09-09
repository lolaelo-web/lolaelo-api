-- Create PMS tables in schema "extranet" only if missing
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables WHERE schemaname = 'extranet' AND tablename = 'PmsConnection'
  ) THEN
    CREATE TABLE "extranet"."PmsConnection" (
      "id" SERIAL PRIMARY KEY,
      "partnerId" INTEGER NOT NULL REFERENCES "extranet"."Partner"("id") ON DELETE CASCADE,
      "provider" TEXT NOT NULL,                                     -- e.g. CLOUDBEDS
      "mode" TEXT NOT NULL DEFAULT 'mock',                          -- mock | live
      "status" TEXT NOT NULL DEFAULT 'TESTING',                     -- TESTING|CONNECTED|ERROR
      "scope" TEXT,
      "accessToken" TEXT,
      "refreshToken" TEXT,
      "tokenExpiresAt" TIMESTAMPTZ,
      "lastSyncAt" TIMESTAMPTZ,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT "PmsConnection_partner_provider_unique" UNIQUE ("partnerId","provider")
    );
    CREATE INDEX "PmsConnection_partner_idx" ON "extranet"."PmsConnection" ("partnerId");
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_tables WHERE schemaname = 'extranet' AND tablename = 'PmsMapping'
  ) THEN
    CREATE TABLE "extranet"."PmsMapping" (
      "id" SERIAL PRIMARY KEY,
      "pmsConnectionId" INTEGER NOT NULL REFERENCES "extranet"."PmsConnection"("id") ON DELETE CASCADE,
      "remoteRoomId" TEXT NOT NULL,
      "remoteRatePlanId" TEXT,
      "localRoomTypeId" INTEGER REFERENCES "extranet"."RoomType"("id") ON DELETE SET NULL,
      "localRatePlanId" INTEGER REFERENCES "extranet"."RatePlan"("id") ON DELETE SET NULL,
      "currency" TEXT,
      "active" BOOLEAN NOT NULL DEFAULT TRUE,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX "PmsMapping_conn_idx" ON "extranet"."PmsMapping" ("pmsConnectionId");
    CREATE INDEX "PmsMapping_remote_idx" ON "extranet"."PmsMapping" ("remoteRoomId","remoteRatePlanId");
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_tables WHERE schemaname = 'extranet' AND tablename = 'SyncLog'
  ) THEN
    CREATE TABLE "extranet"."SyncLog" (
      "id" SERIAL PRIMARY KEY,
      "pmsConnectionId" INTEGER NOT NULL REFERENCES "extranet"."PmsConnection"("id") ON DELETE CASCADE,
      "type" TEXT NOT NULL,      -- AUTH | SYNC | FETCH | etc
      "status" TEXT NOT NULL,    -- SUCCESS | ERROR
      "message" TEXT,
      "startedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "finishedAt" TIMESTAMPTZ,
      "durationMs" INTEGER DEFAULT 0,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX "SyncLog_conn_started_idx" ON "extranet"."SyncLog" ("pmsConnectionId","startedAt" DESC);
  END IF;
END$$;