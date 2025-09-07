// @ts-nocheck
// src/routes/extranetPms.ts
import express from "express";
import * as prismaMod from "../prisma.js";

const db: any =
  (prismaMod as any).prisma ??
  (prismaMod as any).default?.prisma ??
  (prismaMod as any).default ??
  (prismaMod as any);

const router = express.Router();

/**
 * Lightweight health (no DB, no auth) to prove router is mounted.
 * GET /extranet/pms/__ping
 */
router.get("/__ping", (_req, res) => {
  res.json({ ok: true, router: "pms", ts: new Date().toISOString() });
});

// DEBUG: list available Prisma delegates on this build (no DB access)
router.get("/__client", (_req, res) => {
  // exclude internal/private keys
  const keys = Object.keys((prismaMod as any)?.default ?? {}).filter(k => !k.startsWith("_") && !k.startsWith("$"));
  res.json({ ok: true, delegates: keys });
});

/**
 * Auth (Bearer -> ExtranetSession) with ~3s timeout.
 * Sets req.partnerId on success.
 */
router.use(async (req, res, next) => {
  try {
    const auth = req.headers?.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    const now = new Date();
    const sessionLookup = db.extranetSession.findFirst({
      where: { token, revokedAt: null, expiresAt: { gt: now } },
      select: { partnerId: true },
    });

    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("AUTH_TIMEOUT")), 3000)
    );

    const session: any = await Promise.race([sessionLookup, timeout]);
    if (!session) return res.status(401).json({ error: "Unauthorized" });

    req.partnerId = session.partnerId;
    next();
  } catch (e: any) {
    console.error("[PMS auth error]", e?.message || e);
    return res.status(401).json({ error: "Unauthorized" });
  }
});

/**
 * Quick auth check (diagnostic)
 * GET /extranet/pms/whoami
 */
router.get("/whoami", (req, res) => {
  res.json({ ok: true, partnerId: Number(req.partnerId) || null });
});

// Helpers
function toInt(v: any) {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}
function getPartnerId(req: any) {
  return Number(req.partnerId);
}

/**
 * CONNECTIONS
 */

// GET /extranet/pms/connections
router.get("/connections", async (req, res) => {
  try {
    const partnerId = getPartnerId(req);
    if (!partnerId || Number.isNaN(partnerId)) return res.status(401).json({ error: "Unauthorized" });

    const rows = await db.pmsConnection.findMany({
      where: { partnerId },
      orderBy: { id: "asc" },
    });
    res.json(rows);
  } catch (e: any) {
    console.error("[PMS GET /connections error]", e?.message || e);
    res.status(500).json({ error: "Internal", detail: String(e?.message || e) });
  }
});

// POST /extranet/pms/connections  (create or upsert by provider)
router.post("/connections", async (req, res) => {
  try {
    const partnerId = getPartnerId(req);
    if (!partnerId || Number.isNaN(partnerId)) return res.status(401).json({ error: "Unauthorized" });

    const { provider = "CLOUDBEDS", mode = "mock", status = "TESTING", scope } = req.body ?? {};

    const upserted = await db.pmsConnection.upsert({
      where: { partnerId_provider: { partnerId, provider } },
      create: { partnerId, provider, mode, status, scope },
      update: { mode, status, scope, updatedAt: new Date() },
    });

    await db.syncLog.create({
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
  } catch (e: any) {
    console.error("[PMS POST /connections error]", e?.message || e);
    res.status(500).json({ error: "Internal", detail: String(e?.message || e) });
  }
});

// PATCH /extranet/pms/connections/:id
router.patch("/connections/:id", async (req, res) => {
  try {
    const partnerId = getPartnerId(req);
    if (!partnerId || Number.isNaN(partnerId)) return res.status(401).json({ error: "Unauthorized" });

    const id = Number(req.params.id);
    const { mode, status, scope, accessToken, refreshToken, tokenExpiresAt } = req.body ?? {};

    const existing = await db.pmsConnection.findFirst({ where: { id, partnerId } });
    if (!existing) return res.status(404).json({ error: "Not found" });

    const updated = await db.pmsConnection.update({
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
  } catch (e: any) {
    console.error("[PMS PATCH /connections/:id error]", e?.message || e);
    res.status(500).json({ error: "Internal", detail: String(e?.message || e) });
  }
});

// POST /extranet/pms/connections/:id/test
router.post("/connections/:id/test", async (req, res) => {
  try {
    const partnerId = getPartnerId(req);
    if (!partnerId || Number.isNaN(partnerId)) return res.status(401).json({ error: "Unauthorized" });

    const id = Number(req.params.id);

    const conn = await db.pmsConnection.findFirst({ where: { id, partnerId } });
    if (!conn) return res.status(404).json({ error: "Not found" });

    const start = Date.now();
    const ok = true; // mock “ok”

    const newConn = await db.pmsConnection.update({
      where: { id: conn.id },
      data: { status: ok ? "CONNECTED" : "ERROR", lastSyncAt: new Date() },
    });

    await db.syncLog.create({
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
  } catch (e: any) {
    console.error("[PMS POST /connections/:id/test error]", e?.message || e);
    res.status(500).json({ error: "Internal", detail: String(e?.message || e) });
  }
});

// DELETE /extranet/pms/connections/:id
router.delete("/connections/:id", async (req, res) => {
  try {
    const partnerId = getPartnerId(req);
    if (!partnerId || Number.isNaN(partnerId)) return res.status(401).json({ error: "Unauthorized" });

    const id = Number(req.params.id);
    const existing = await db.pmsConnection.findFirst({ where: { id, partnerId } });
    if (!existing) return res.status(404).json({ error: "Not found" });

    await db.pmsMapping.deleteMany({ where: { pmsConnectionId: id } });
    await db.syncLog.deleteMany({ where: { pmsConnectionId: id } });
    await db.pmsConnection.delete({ where: { id } });

    res.json({ deleted: true });
  } catch (e: any) {
    console.error("[PMS DELETE /connections/:id error]", e?.message || e);
    res.status(500).json({ error: "Internal", detail: String(e?.message || e) });
  }
});

/**
 * MAPPINGS
 */

// GET /extranet/pms/mappings
router.get("/mappings", async (req, res) => {
  try {
    const partnerId = getPartnerId(req);
    if (!partnerId || Number.isNaN(partnerId)) return res.status(401).json({ error: "Unauthorized" });

    const rows = await db.pmsMapping.findMany({
      where: { connection: { partnerId } },
      include: {
        connection: true,
        roomType: { select: { id: true, name: true } },
        ratePlan: { select: { id: true, name: true } },
      },
      orderBy: { id: "asc" },
    });

    res.json(rows);
  } catch (e: any) {
    console.error("[PMS GET /mappings error]", e?.message || e);
    res.status(500).json({ error: "Internal", detail: String(e?.message || e) });
  }
});

// POST /extranet/pms/mappings
router.post("/mappings", async (req, res) => {
  try {
    const partnerId = getPartnerId(req);
    if (!partnerId || Number.isNaN(partnerId)) return res.status(401).json({ error: "Unauthorized" });

    const {
      pmsConnectionId,
      remoteRoomId,
      remoteRatePlanId,
      localRoomTypeId,
      localRatePlanId,
      currency,
      active = true,
    } = req.body ?? {};

    const conn = await db.pmsConnection.findFirst({
      where: { id: Number(pmsConnectionId), partnerId },
    });
    if (!conn) return res.status(400).json({ error: "Invalid pmsConnectionId" });

    const created = await db.pmsMapping.create({
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
  } catch (e: any) {
    console.error("[PMS POST /mappings error]", e?.message || e);
    res.status(500).json({ error: "Internal", detail: String(e?.message || e) });
  }
});

// PATCH /extranet/pms/mappings/:id
router.patch("/mappings/:id", async (req, res) => {
  try {
    const partnerId = getPartnerId(req);
    if (!partnerId || Number.isNaN(partnerId)) return res.status(401).json({ error: "Unauthorized" });

    const id = Number(req.params.id);

    const mapping = await db.pmsMapping.findFirst({
      where: { id, connection: { partnerId } },
    });
    if (!mapping) return res.status(404).json({ error: "Not found" });

    const { localRoomTypeId, localRatePlanId, currency, active } = req.body ?? {};

    const updated = await db.pmsMapping.update({
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
  } catch (e: any) {
    console.error("[PMS PATCH /mappings/:id error]", e?.message || e);
    res.status(500).json({ error: "Internal", detail: String(e?.message || e) });
  }
});

// DELETE /extranet/pms/mappings/:id
router.delete("/mappings/:id", async (req, res) => {
  try {
    const partnerId = getPartnerId(req);
    if (!partnerId || Number.isNaN(partnerId)) return res.status(401).json({ error: "Unauthorized" });

    const id = Number(req.params.id);

    const mapping = await db.pmsMapping.findFirst({
      where: { id, connection: { partnerId } },
    });
    if (!mapping) return res.status(404).json({ error: "Not found" });

    await db.pmsMapping.delete({ where: { id } });
    res.json({ deleted: true });
  } catch (e: any) {
    console.error("[PMS DELETE /mappings/:id error]", e?.message || e);
    res.status(500).json({ error: "Internal", detail: String(e?.message || e) });
  }
});

/**
 * LOGS
 */

// GET /extranet/pms/logs?limit=50
router.get("/logs", async (req, res) => {
  try {
    const partnerId = getPartnerId(req);
    if (!partnerId || Number.isNaN(partnerId)) return res.status(401).json({ error: "Unauthorized" });

    const limit = Math.min(200, Number(req.query.limit) || 50);

    const rows = await db.syncLog.findMany({
      where: { connection: { partnerId } },
      orderBy: { startedAt: "desc" },
      take: limit,
    });

    res.json(rows);
  } catch (e: any) {
    console.error("[PMS GET /logs error]", e?.message || e);
    res.status(500).json({ error: "Internal", detail: String(e?.message || e) });
  }
});

export default router;
