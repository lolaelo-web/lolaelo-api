-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('GOVT_ID', 'BUSINESS_REG', 'TAX_ID', 'BANK_PROOF', 'PROOF_OF_ADDRESS', 'INSURANCE_LIABILITY', 'PROPERTY_OWNERSHIP', 'LOCAL_LICENSE');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('REQUIRED', 'SUBMITTED', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "Waitlist" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Waitlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerApplication" (
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
CREATE TABLE "ContentBlock" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Partner" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Partner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtranetLoginCode" (
    "id" SERIAL NOT NULL,
    "partnerId" INTEGER NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "ExtranetLoginCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtranetSession" (
    "id" SERIAL NOT NULL,
    "partnerId" INTEGER NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ExtranetSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PropertyProfile" (
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
CREATE TABLE "PropertyPhoto" (
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
CREATE TABLE "PropertyDocument" (
    "id" SERIAL NOT NULL,
    "partnerId" INTEGER NOT NULL,
    "type" "DocumentType" NOT NULL,
    "key" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "fileName" TEXT,
    "contentType" TEXT,
    "status" "DocumentStatus" NOT NULL DEFAULT 'SUBMITTED',
    "notes" TEXT,
    "expiresAt" TIMESTAMP(3),
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMP(3),

    CONSTRAINT "PropertyDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoomType" (
    "id" SERIAL NOT NULL,
    "partnerId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "maxGuests" INTEGER NOT NULL DEFAULT 2,
    "basePrice" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoomType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RatePlan" (
    "id" SERIAL NOT NULL,
    "partnerId" INTEGER NOT NULL,
    "roomTypeId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "policy" TEXT,
    "priceDelta" DECIMAL(10,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RatePlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoomInventory" (
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
CREATE TABLE "RoomPrice" (
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
CREATE UNIQUE INDEX "ContentBlock_key_key" ON "ContentBlock"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Partner_email_key" ON "Partner"("email");

-- CreateIndex
CREATE INDEX "ExtranetLoginCode_partnerId_idx" ON "ExtranetLoginCode"("partnerId");

-- CreateIndex
CREATE INDEX "ExtranetLoginCode_expiresAt_idx" ON "ExtranetLoginCode"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExtranetSession_token_key" ON "ExtranetSession"("token");

-- CreateIndex
CREATE INDEX "ExtranetSession_partnerId_idx" ON "ExtranetSession"("partnerId");

-- CreateIndex
CREATE INDEX "ExtranetSession_expiresAt_idx" ON "ExtranetSession"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PropertyProfile_partnerId_key" ON "PropertyProfile"("partnerId");

-- CreateIndex
CREATE UNIQUE INDEX "PropertyPhoto_key_key" ON "PropertyPhoto"("key");

-- CreateIndex
CREATE INDEX "PropertyPhoto_partnerId_sortOrder_idx" ON "PropertyPhoto"("partnerId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "PropertyDocument_key_key" ON "PropertyDocument"("key");

-- CreateIndex
CREATE INDEX "PropertyDocument_partnerId_status_idx" ON "PropertyDocument"("partnerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PropertyDocument_partnerId_type_key" ON "PropertyDocument"("partnerId", "type");

-- CreateIndex
CREATE INDEX "RoomType_partnerId_idx" ON "RoomType"("partnerId");

-- CreateIndex
CREATE UNIQUE INDEX "RoomType_partnerId_name_key" ON "RoomType"("partnerId", "name");

-- CreateIndex
CREATE INDEX "RatePlan_partnerId_idx" ON "RatePlan"("partnerId");

-- CreateIndex
CREATE UNIQUE INDEX "RatePlan_roomTypeId_name_key" ON "RatePlan"("roomTypeId", "name");

-- CreateIndex
CREATE INDEX "RoomInventory_partnerId_date_idx" ON "RoomInventory"("partnerId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "RoomInventory_roomTypeId_date_key" ON "RoomInventory"("roomTypeId", "date");

-- CreateIndex
CREATE INDEX "RoomPrice_partnerId_date_idx" ON "RoomPrice"("partnerId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "RoomPrice_roomTypeId_ratePlanId_date_key" ON "RoomPrice"("roomTypeId", "ratePlanId", "date");

-- AddForeignKey
ALTER TABLE "ExtranetLoginCode" ADD CONSTRAINT "ExtranetLoginCode_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtranetSession" ADD CONSTRAINT "ExtranetSession_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyProfile" ADD CONSTRAINT "PropertyProfile_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyPhoto" ADD CONSTRAINT "PropertyPhoto_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyDocument" ADD CONSTRAINT "PropertyDocument_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomType" ADD CONSTRAINT "RoomType_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RatePlan" ADD CONSTRAINT "RatePlan_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "RoomType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RatePlan" ADD CONSTRAINT "RatePlan_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomInventory" ADD CONSTRAINT "RoomInventory_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "RoomType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomInventory" ADD CONSTRAINT "RoomInventory_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomPrice" ADD CONSTRAINT "RoomPrice_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "RoomType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomPrice" ADD CONSTRAINT "RoomPrice_ratePlanId_fkey" FOREIGN KEY ("ratePlanId") REFERENCES "RatePlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomPrice" ADD CONSTRAINT "RoomPrice_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE CASCADE ON UPDATE CASCADE;
