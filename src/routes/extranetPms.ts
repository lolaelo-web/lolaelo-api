// @ts-nocheck
// src/routes/extranetPms.ts
import express from "express";
import { prisma } from "../prisma.js";

const router = express.Router();

/**
 * Lightweight auth for PMS routes:
 * - Reads Bearer token
 * - Looks up ExtranetSession (not revoked, not expired)
 * - Sets req.partnerId
 */
router.use(async (req, res, next) => {
  try {
    const auth = req.headers?.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    const now = new Date();
    const session = await prisma.extranetSession.findFirst({
      where: {
        token,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      select: { partnerId: true },
    });
    if (!session) return res.status(401).json({ error: "Unauthorized" });

    req.partnerId = session.partnerId;
    next();
  } catch (e) {
    console.error("[PMS auth error]", e);
    res.status(401).json({ error: "Unauthorized" });
  }
});

// Helpers
function toInt(v) {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}
function getPartnerId(req) {
  return Number(req.partnerId);
}

/**
 * CONNECTIONS
 */

// GET /extranet/pms/connections
router.get("/connections", async (req, res) => {
  const partnerId = getPartnerId(req);
  const rows = await prisma.pmsConnection.findMany({
    where: { partnerId },
    orderBy: { id: "asc" },
  });
  res.json(rows);
});

// POST /extranet/pms/connections  (create or upsert by provider)
router.post("/connections", async (req, res) => {
  const partnerId = getPartnerId(req);
  const {
    provider = "CLOUDBEDS",
    mode = "mock",
    status = "TESTING",
    scope,
  } = req.body ?? {};

  const upserted = await prisma.pmsConnection.upsert({
    where: { partnerId_provider: { partnerId, provider } },
    create: { partnerId, provider, mode, status, scope },
    update: { mode, status, scope, updatedAt: new Date() },
  });

  await prisma.syncLog.create({
    data: {
      pmsConnectionId: upserted.id,
      type: "AUTH",
      status: "SUCCESS",
      message: `Connection created/updated: mode=${upserted.mode}, status=${upserted.status}`,
      startedAt: new Date(),
      finishedAt: new Date(),
      durationMs: 0,
    },
  });

  res.json(upserted);
});

// PATCH /extranet/pms/connections/:id
router.patch("/connections/:id", async (req, res) => {
  const partnerId = getPartnerId(req);
  const id = Number(req.params.id);
  const { mode, status, scope, accessToken, refreshToken, tokenExpiresAt } = req.body ?? {};

  const existing = await prisma.pmsConnection.findFirst({ where: { id, partnerId } });
  if (!existing) return res.status(404).json({ error: "Not found" });

  const updated = await prisma.pmsConnection.update({
    where: { id },
    data: {
      mode: mode ?? existing.mode,
      status: status ?? existing.status,
      scope: scope ?? existing.scope,
      accessToken: accessToken ?? existing.accessToken,
      refreshToken: refreshToken ?? existing.refreshToken,
      tokenExpiresAt: tokenExpiresAt ? new Date(tokenExpiresAt) : existing.tokenExpiresAt,
      updatedAt: new Date(),
    },
  });

  res.json(updated);
});

// POST /extranet/pms/connections/:id/test
router.post("/connections/:id/test", async (req, res) => {
  const partnerId = getPartnerId(req);
  const id = Number(req.params.id);

  const conn = await prisma.pmsConnection.findFirst({ where: { id, partnerId } });
  if (!conn) return res.status(404).json({ error: "Not found" });

  const start = Date.now();
  const ok = true; // mock “ok”

  const newConn = await prisma.pmsConnection.update({
    where: { id: conn.id },
    data: { status: ok ? "CONNECTED" : "ERROR", lastSyncAt: new Date() },
  });

  await prisma.syncLog.create({
    data: {
      pmsConnectionId: conn.id,
      type: "AUTH",
      status: ok ? "SUCCESS" : "ERROR",
      message: ok ? "Mock connection test passed" : "Mock connection test failed",
      startedAt: new Date(start),
      finishedAt: new Date(),
      durationMs: Date.now() - start,
    },
  });

  res.json({ ok, connection: newConn, logStatus: ok ? "SUCCESS" : "ERROR" });
});

// DELETE /extranet/pms/connections/:id
router.delete("/connections/:id", async (req, res) => {
  const partnerId = getPartnerId(req);
  const id = Number(req.params.id);
  const existing = await prisma.pmsConnection.findFirst({ where: { id, partnerId } });
  if (!existing) return res.status(404).json({ error: "Not found" });

  await prisma.pmsMapping.deleteMany({ where: { pmsConnectionId: id } });
  await prisma.syncLog.deleteMany({ where: { pmsConnectionId: id } });
  await prisma.pmsConnection.delete({ where: { id } });

  res.json({ deleted: true });
});

/**
 * MAPPINGS
 */

// GET /extranet/pms/mappings
router.get("/mappings", async (req, res) => {
  const partnerId = getPartnerId(req);

  const rows = await prisma.pmsMapping.findMany({
    where: { connection: { partnerId } },
    include: {
      connection: true,
      roomType: { select: { id: true, name: true } },
      ratePlan: { select: { id: true, name: true } },
    },
    orderBy: { id: "asc" },
  });

  res.json(rows);
});

// POST /extranet/pms/mappings
router.post("/mappings", async (req, res) => {
  const partnerId = getPartnerId(req);
  const {
    pmsConnectionId,
    remoteRoomId,
    remoteRatePlanId,
    localRoomTypeId,
    localRatePlanId,
    currency,
    active = true,
  } = req.body ?? {};

  const conn = await prisma.pmsConnection.findFirst({
    where: { id: Number(pmsConnectionId), partnerId },
  });
  if (!conn) return res.status(400).json({ error: "Invalid pmsConnectionId" });

  const created = await prisma.pmsMapping.create({
    data: {
      pmsConnectionId: conn.id,
      remoteRoomId: String(remoteRoomId),
      remoteRatePlanId: remoteRatePlanId ? String(remoteRatePlanId) : null,
      localRoomTypeId: toInt(localRoomTypeId),
      localRatePlanId: toInt(localRatePlanId),
      currency: currency ?? null,
      active,
    },
  });

  res.json(created);
});

// PATCH /extranet/pms/mappings/:id
router.patch("/mappings/:id", async (req, res) => {
  const partnerId = getPartnerId(req);
  const id = Number(req.params.id);

  const mapping = await prisma.pmsMapping.findFirst({
    where: { id, connection: { partnerId } },
  });
  if (!mapping) return res.status(404).json({ error: "Not found" });

  const { localRoomTypeId, localRatePlanId, currency, active } = req.body ?? {};

  const updated = await prisma.pmsMapping.update({
    where: { id },
    data: {
      localRoomTypeId: localRoomTypeId === undefined ? mapping.localRoomTypeId : toInt(localRoomTypeId),
      localRatePlanId: localRatePlanId === undefined ? mapping.localRatePlanId : toInt(localRatePlanId),
      currency: currency === undefined ? mapping.currency : currency,
      active: active === undefined ? mapping.active : !!active,
      updatedAt: new Date(),
    },
  });

  res.json(updated);
});

// DELETE /extranet/pms/mappings/:id
router.delete("/mappings/:id", async (req, res) => {
  const partnerId = getPartnerId(req);
  const id = Number(req.params.id);

  const mapping = await prisma.pmsMapping.findFirst({
    where: { id, connection: { partnerId } },
  });
  if (!mapping) return res.status(404).json({ error: "Not found" });

  await prisma.pmsMapping.delete({ where: { id } });
  res.json({ deleted: true });
});

/**
 * LOGS
 */

// GET /extranet/pms/logs?limit=50
router.get("/logs", async (req, res) => {
  const partnerId = getPartnerId(req);
  const limit = Math.min(200, Number(req.query.limit) || 50);

  const rows = await prisma.syncLog.findMany({
    where: { connection: { partnerId } },
    orderBy: { startedAt: "desc" },
    take: limit,
  });

  res.json(rows);
});

export default router;
