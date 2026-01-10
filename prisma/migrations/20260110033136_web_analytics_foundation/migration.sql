-- Web analytics foundation (extranet-only)

CREATE TABLE IF NOT EXISTS extranet."WebAnalyticsSession" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endedAt" TIMESTAMP(3),

  "landingPath" TEXT,
  "landingUrl" TEXT,
  "referrer" TEXT,
  "referrerHost" TEXT,

  "utmSource" TEXT,
  "utmMedium" TEXT,
  "utmCampaign" TEXT,
  "utmContent" TEXT,

  "userAgent" TEXT,
  "deviceType" TEXT,
  "country" TEXT,
  "ipHash" TEXT,
  "isBot" BOOLEAN NOT NULL DEFAULT false,

  CONSTRAINT "WebAnalyticsSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS extranet."WebAnalyticsEvent" (
  "id" BIGSERIAL NOT NULL,
  "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sessionId" TEXT NOT NULL,

  "name" TEXT NOT NULL,
  "path" TEXT,
  "url" TEXT,
  "title" TEXT,
  "referrer" TEXT,
  "activeMs" INTEGER,
  "payload" JSONB,

  CONSTRAINT "WebAnalyticsEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS extranet."WebAnalyticsDaily" (
  "id" TEXT NOT NULL,
  "day" TIMESTAMP(3) NOT NULL,

  "utmSource" TEXT,
  "utmMedium" TEXT,
  "utmCampaign" TEXT,
  "referrerHost" TEXT,
  "landingPath" TEXT,

  "sessions" INTEGER NOT NULL DEFAULT 0,
  "pageViews" INTEGER NOT NULL DEFAULT 0,
  "engagedMs" BIGINT NOT NULL DEFAULT 0,

  CONSTRAINT "WebAnalyticsDaily_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX IF NOT EXISTS "WebAnalyticsSession_createdAt_idx"
  ON extranet."WebAnalyticsSession"("createdAt");

CREATE INDEX IF NOT EXISTS "WebAnalyticsSession_lastSeenAt_idx"
  ON extranet."WebAnalyticsSession"("lastSeenAt");

CREATE INDEX IF NOT EXISTS "WebAnalyticsSession_utmSource_utmMedium_utmCampaign_idx"
  ON extranet."WebAnalyticsSession"("utmSource", "utmMedium", "utmCampaign");

CREATE INDEX IF NOT EXISTS "WebAnalyticsEvent_ts_idx"
  ON extranet."WebAnalyticsEvent"("ts");

CREATE INDEX IF NOT EXISTS "WebAnalyticsEvent_sessionId_ts_idx"
  ON extranet."WebAnalyticsEvent"("sessionId", "ts");

CREATE INDEX IF NOT EXISTS "WebAnalyticsEvent_name_ts_idx"
  ON extranet."WebAnalyticsEvent"("name", "ts");

CREATE INDEX IF NOT EXISTS "WebAnalyticsEvent_path_ts_idx"
  ON extranet."WebAnalyticsEvent"("path", "ts");

CREATE INDEX IF NOT EXISTS "WebAnalyticsDaily_day_idx"
  ON extranet."WebAnalyticsDaily"("day");

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_web_analytics_daily_dims"
  ON extranet."WebAnalyticsDaily"("day","utmSource","utmMedium","utmCampaign","referrerHost","landingPath");

-- FK
ALTER TABLE extranet."WebAnalyticsEvent"
  ADD CONSTRAINT "WebAnalyticsEvent_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES extranet."WebAnalyticsSession"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
