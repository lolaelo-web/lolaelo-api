-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "public"."DocumentType" AS ENUM ('GOVT_ID', 'BUSINESS_REG', 'TAX_ID', 'BANK_PROOF', 'PROOF_OF_ADDRESS', 'INSURANCE_LIABILITY', 'PROPERTY_OWNERSHIP', 'LOCAL_LICENSE');

-- CreateEnum
CREATE TYPE "public"."DocumentStatus" AS ENUM ('REQUIRED', 'SUBMITTED', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "public"."Waitlist" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Waitlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PartnerApplication" (
    "id" SERIAL NOT NULL,
    "companyName" TEXT NOT NULL,
    "contactName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "location" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartnerApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ContentBlock" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Partner" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Partner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ExtranetLoginCode" (
    "id" SERIAL NOT NULL,
    "partnerId" INTEGER NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "ExtranetLoginCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ExtranetSession" (
    "id" SERIAL NOT NULL,
    "partnerId" INTEGER NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ExtranetSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PropertyProfile" (
    "id" SERIAL NOT NULL,
    "partnerId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "addressLine" TEXT,
    "city" TEXT,
    "country" TEXT,
    "contactEmail" TEXT,
    "phone" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PropertyPhoto" (
    "id" SERIAL NOT NULL,
    "partnerId" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "alt" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isCover" BOOLEAN NOT NULL DEFAULT false,
    "width" INTEGER,
    "height" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PropertyPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PropertyDocument" (
    "id" SERIAL NOT NULL,
    "partnerId" INTEGER NOT NULL,
    "type" "public"."DocumentType" NOT NULL,
    "key" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "fileName" TEXT,
    "contentType" TEXT,
    "status" "public"."DocumentStatus" NOT NULL DEFAULT 'SUBMITTED',
    "notes" TEXT,
    "expiresAt" TIMESTAMP(3),
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMP(3),

    CONSTRAINT "PropertyDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."RoomType" (
    "id" SERIAL NOT NULL,
    "partnerId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "maxGuests" INTEGER NOT NULL DEFAULT 2,
    "occupancy" INTEGER NOT NULL DEFAULT 2,
    "basePrice" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoomType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."RatePlan" (
    "id" SERIAL NOT NULL,
    "partnerId" INTEGER NOT NULL,
    "roomTypeId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "exposeToUis" BOOLEAN NOT NULL DEFAULT true,
    "uisPriority" INTEGER NOT NULL DEFAULT 100,
    "policy" TEXT,
    "priceDelta" DECIMAL(10,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RatePlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."RoomInventory" (
    "id" SERIAL NOT NULL,
    "partnerId" INTEGER NOT NULL,
    "roomTypeId" INTEGER NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "roomsOpen" INTEGER NOT NULL DEFAULT 0,
    "isClosed" BOOLEAN NOT NULL DEFAULT false,
    "minStay" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoomInventory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."RoomPrice" (
    "id" SERIAL NOT NULL,
    "partnerId" INTEGER NOT NULL,
    "roomTypeId" INTEGER NOT NULL,
    "ratePlanId" INTEGER,
    "date" TIMESTAMP(3) NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoomPrice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ContentBlock_key_key" ON "public"."ContentBlock"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Partner_email_key" ON "public"."Partner"("email");

-- CreateIndex
CREATE INDEX "ExtranetLoginCode_partnerId_idx" ON "public"."ExtranetLoginCode"("partnerId");

-- CreateIndex
CREATE INDEX "ExtranetLoginCode_expiresAt_idx" ON "public"."ExtranetLoginCode"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExtranetSession_token_key" ON "public"."ExtranetSession"("token");

-- CreateIndex
CREATE INDEX "ExtranetSession_partnerId_idx" ON "public"."ExtranetSession"("partnerId");

-- CreateIndex
CREATE INDEX "ExtranetSession_expiresAt_idx" ON "public"."ExtranetSession"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PropertyProfile_partnerId_key" ON "public"."PropertyProfile"("partnerId");

-- CreateIndex
CREATE UNIQUE INDEX "PropertyPhoto_key_key" ON "public"."PropertyPhoto"("key");

-- CreateIndex
CREATE INDEX "PropertyPhoto_partnerId_sortOrder_idx" ON "public"."PropertyPhoto"("partnerId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "PropertyDocument_key_key" ON "public"."PropertyDocument"("key");

-- CreateIndex
CREATE INDEX "PropertyDocument_partnerId_status_idx" ON "public"."PropertyDocument"("partnerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PropertyDocument_partnerId_type_key" ON "public"."PropertyDocument"("partnerId", "type");

-- CreateIndex
CREATE INDEX "RoomType_partnerId_idx" ON "public"."RoomType"("partnerId");

-- CreateIndex
CREATE UNIQUE INDEX "RoomType_partnerId_name_key" ON "public"."RoomType"("partnerId", "name");

-- CreateIndex
CREATE INDEX "RatePlan_partnerId_idx" ON "public"."RatePlan"("partnerId");

-- CreateIndex
CREATE INDEX "RatePlan_partnerId_uisPriority_idx" ON "public"."RatePlan"("partnerId", "uisPriority");

-- CreateIndex
CREATE UNIQUE INDEX "RatePlan_roomTypeId_name_key" ON "public"."RatePlan"("roomTypeId", "name");

-- CreateIndex
CREATE INDEX "RoomInventory_partnerId_date_idx" ON "public"."RoomInventory"("partnerId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "RoomInventory_roomTypeId_date_key" ON "public"."RoomInventory"("roomTypeId", "date");

-- CreateIndex
CREATE INDEX "RoomPrice_partnerId_date_idx" ON "public"."RoomPrice"("partnerId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "RoomPrice_roomTypeId_ratePlanId_date_key" ON "public"."RoomPrice"("roomTypeId", "ratePlanId", "date");

-- AddForeignKey
ALTER TABLE "public"."ExtranetLoginCode" ADD CONSTRAINT "ExtranetLoginCode_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "public"."Partner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ExtranetSession" ADD CONSTRAINT "ExtranetSession_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "public"."Partner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PropertyProfile" ADD CONSTRAINT "PropertyProfile_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "public"."Partner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PropertyPhoto" ADD CONSTRAINT "PropertyPhoto_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "public"."Partner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PropertyDocument" ADD CONSTRAINT "PropertyDocument_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "public"."Partner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RoomType" ADD CONSTRAINT "RoomType_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "public"."Partner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RatePlan" ADD CONSTRAINT "RatePlan_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "public"."RoomType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RatePlan" ADD CONSTRAINT "RatePlan_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "public"."Partner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RoomInventory" ADD CONSTRAINT "RoomInventory_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "public"."RoomType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RoomInventory" ADD CONSTRAINT "RoomInventory_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "public"."Partner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RoomPrice" ADD CONSTRAINT "RoomPrice_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "public"."RoomType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RoomPrice" ADD CONSTRAINT "RoomPrice_ratePlanId_fkey" FOREIGN KEY ("ratePlanId") REFERENCES "public"."RatePlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RoomPrice" ADD CONSTRAINT "RoomPrice_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "public"."Partner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

