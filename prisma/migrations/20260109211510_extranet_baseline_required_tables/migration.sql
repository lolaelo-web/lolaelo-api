-- Baseline: ensure extranet schema and core tables exist for shadow DB
CREATE SCHEMA IF NOT EXISTS extranet;

CREATE TABLE IF NOT EXISTS extranet."Partner" (
  "id" SERIAL PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS extranet."RoomType" (
  "id" SERIAL PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS extranet."RatePlan" (
  "id" SERIAL PRIMARY KEY
);
