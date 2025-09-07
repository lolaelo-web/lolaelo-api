// @ts-nocheck
// src/routes/extranetPms.ts
import express from "express";
import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __pmsPrisma__: PrismaClient | undefined;
}
const db: PrismaClient = globalThis.__pmsPrisma__ ?? new PrismaClient();
globalThis.__pmsPrisma__ = db;

const router = express.Router();

/* ----------------------------- Diagnostics (no auth) ----------------------------- */

router.get("/__ping", (_req, res) => {
  res.json({ ok: true, router: "pms", ts: new Date().toISOString() });
});

router.get("/__client", (_req, res) => {
  try {
    const names = [
      "extranetSession",
      "pmsConnection",
      "pmsMapping",
      "syncLog",
      "roomType",
      "ratePlan",
      "roomInventory",
      "roomPrice",
      "propertyProfile",
      "propertyPhoto",
      "propertyDocument",
      "partner",
    ];
    const delegates: Record<string, boolean> = {};
    for (const n of names) delegates[n] = typeof (db as any)[n]?.findMany === "function";
    res.json({ ok: true, delegates });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* ----------------------------------- Auth ----------------------------------- */
// Bearer token -> ExtranetSession (3s timeout), sets req.partnerId
router.use(async (req, res, next) => {
  try {
    const auth = req.headers?.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    const now = new Date();
    const lookup = db.extranetSession.findFirst({
      where: { token, revokedAt: null, expiresAt: { gt: now } },
      select: { partnerId: true },
    });
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("AUTH_TIMEOUT")), 3000));
    const session: any = await Promise.race([lookup, timeout]);

    if (!session) return res.status(401).json({ error: "Unauthorized" });
    (req as any).partnerId = session.partnerId;
    next();
  } catch (e: any) {
    console.error("[PMS auth error]", e?.message || e);
    return res.status(401).json({ error: "Unauthorized" });
  }
});

router.get("/whoami", (req, res) => {
  res.json({ ok: true, partnerId: Number((req as any).partnerId) || null });
});

/* --------------------------------- Helpers --------------------------------- */

function toInt(v: any) {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}
function getPartnerId(req: any) {
  return Number(req.partnerId);
}
function hasDelegates() {
  const anyDb: any = db;
  return (
    typeof anyDb?.pmsConnection?.findMany === "function" &&
    typeof anyDb?.pmsMapping?.findMany === "function" &&
    typeof anyDb?.syncLog?.findMany === "function"
  );
}

/* ------------------------------- CONNECTIONS ------------------------------- */

// GET /extranet/pms/connections
router.get("/connections", async (req, res) => {
  try {
    const partnerId = getPartnerId(req);
    if (!partnerId || Number.isNaN(partnerId)) return res.status(401).json({ error: "Unauthorized" });

    if (hasDelegates()) {
      const rows = await (db as any).pmsConnection.findMany({ where: { partnerId }, orderBy: { id: "asc" } });
      return res.json(rows);
    }

    // RAW fallback
    const rows = await (db as any).$queryRawUnsafe(
      'SELECT * FROM "extranet"."PmsConnection" WHERE "partnerId" = $1 ORDER BY "id" ASC',
      partnerId
    );
    return res.json(rows);
  } catch (e: any) {
    console.error("[PMS GET /connections error]", e?.message || e);
    res.status(500).json({ error: "Internal", detail: String(e?.message || e) });
  }
});

// POST /extranet/pms/connections  (upsert by partnerId+provider)
router.post("/connections", async (req, res) => {
  try {
    const partnerId = getPartnerId(req);
    if (!partnerId || Number.isNaN(partnerId)) return res.status(401).json({ error: "Unauthorized" });
    const { provider = "CLOUDBEDS", mode = "mock", status = "TESTING", scope = null } = req.body ?? {};

    if (hasDelegates()) {
      const upserted = await (db as any).pmsConnection.upsert({
        where: { partnerId_provider: { partnerId, provider } },
        create: { partnerId, provider, mode, status, scope },
        update: { mode, status, scope, updatedAt: new Date() },
      });
      await (db as any).syncLog.create({
        data: {
          pmsConnectionId: upserted.id,
          type: "AUTH",
          status: "SUCCESS",
          message: `Connection upserted: mode=${upserted.mode}, status=${upserted.status}`,
          startedAt: new Date(),
          finishedAt: new Date(),
          durationMs: 0,
        },
      });
      return res.json(upserted);
    }

    // RAW fallback: INSERT ... ON CONFLICT ("partnerId","provider") DO UPDATE ...
    const upsertSql = `
      INSERT INTO "extranet"."PmsConnection"
        ("partnerId","provider","mode","status","scope","createdAt","updatedAt")
      VALUES ($1,$2,$3,$4,$5, NOW(), NOW())
      ON CONFLICT ("partnerId","provider")
      DO UPDATE SET "mode" = EXCLUDED."mode",
                    "status" = EXCLUDED."status",
                    "scope" = EXCLUDED."scope",
                    "updatedAt" = NOW()
      RETURNING *;
    `;
    const rows = await (db as any).$queryRawUnsafe(upsertSql, partnerId, provider, mode, status, scope);
    const conn = rows?.[0];

    // log
    await (db as any).$executeRawUnsafe(
      `INSERT INTO "extranet"."SyncLog"
       ("pmsConnectionId","type","status","message","startedAt","finishedAt","durationMs","createdAt","updatedAt")
       VALUES ($1,'AUTH','SUCCESS',$2,NOW(),NOW(),0,NOW(),NOW())`,
      conn.id,
      `Connection upserted: mode=${conn.mode}, status=${conn.status}`
    );

    return res.json(conn);
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

    if (hasDelegates()) {
      const existing = await (db as any).pmsConnection.findFirst({ where: { id, partnerId } });
      if (!existing) return res.status(404).json({ error: "Not found" });

      const updated = await (db as any).pmsConnection.update({
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
      return res.json(updated);
    }

    // RAW fallback
    const updateSql = `
      UPDATE "extranet"."PmsConnection"
      SET "mode" = COALESCE($2,"mode"),
          "status" = COALESCE($3,"status"),
          "scope" = COALESCE($4,"scope"),
          "accessToken" = COALESCE($5,"accessToken"),
          "refreshToken" = COALESCE($6,"refreshToken"),
          "tokenExpiresAt" = COALESCE($7,"tokenExpiresAt"),
          "updatedAt" = NOW()
      WHERE "id"=$1 AND "partnerId"=$8
      RETURNING *;
    `;
    const rows = await (db as any).$queryRawUnsafe(
      updateSql,
      id,
      mode ?? null,
      status ?? null,
      scope ?? null,
      accessToken ?? null,
      refreshToken ?? null,
      tokenExpiresAt ? new Date(tokenExpiresAt) : null,
      partnerId
    );
    if (!rows?.length) return res.status(404).json({ error: "Not found" });
    return res.json(rows[0]);
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

    const ok = true;
    if (hasDelegates()) {
      const conn = await (db as any).pmsConnection.findFirst({ where: { id, partnerId } });
      if (!conn) return res.status(404).json({ error: "Not found" });

      const start = Date.now();
      const newConn = await (db as any).pmsConnection.update({
        where: { id: conn.id },
        data: { status: ok ? "CONNECTED" : "ERROR", lastSyncAt: new Date() },
      });
      await (db as any).syncLog.create({
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
      return res.json({ ok, connection: newConn, logStatus: ok ? "SUCCESS" : "ERROR" });
    }

    // RAW fallback
    const connRows = await (db as any).$queryRawUnsafe(
      'SELECT * FROM "extranet"."PmsConnection" WHERE "id"=$1 AND "partnerId"=$2',
      id, partnerId
    );
    if (!connRows?.length) return res.status(404).json({ error: "Not found" });

    await (db as any).$executeRawUnsafe(
      'UPDATE "extranet"."PmsConnection" SET "status"=$1, "lastSyncAt"=NOW(), "updatedAt"=NOW() WHERE "id"=$2',
      ok ? "CONNECTED" : "ERROR",
      id
    );
    await (db as any).$executeRawUnsafe(
      `INSERT INTO "extranet"."SyncLog"
       ("pmsConnectionId","type","status","message","startedAt","finishedAt","durationMs","createdAt","updatedAt")
       VALUES ($1,'AUTH',$2,$3,NOW(),NOW(),0,NOW(),NOW())`,
      id, ok ? "SUCCESS" : "ERROR", ok ? "Mock connection test passed" : "Mock connection test failed"
    );
    const updated = await (db as any).$queryRawUnsafe('SELECT * FROM "extranet"."PmsConnection" WHERE "id"=$1', id);
    return res.json({ ok, connection: updated?.[0], logStatus: ok ? "SUCCESS" : "ERROR" });
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

    if (hasDelegates()) {
      const existing = await (db as any).pmsConnection.findFirst({ where: { id, partnerId } });
      if (!existing) return res.status(404).json({ error: "Not found" });
      await (db as any).pmsMapping.deleteMany({ where: { pmsConnectionId: id } });
      await (db as any).syncLog.deleteMany({ where: { pmsConnectionId: id } });
      await (db as any).pmsConnection.delete({ where: { id } });
      return res.json({ deleted: true });
    }

    // RAW fallback
    await (db as any).$executeRawUnsafe('DELETE FROM "extranet"."PmsMapping" WHERE "pmsConnectionId"=$1', id);
    await (db as any).$executeRawUnsafe('DELETE FROM "extranet"."SyncLog" WHERE "pmsConnectionId"=$1', id);
    const delRows = await (db as any).$queryRawUnsafe(
      'DELETE FROM "extranet"."PmsConnection" WHERE "id"=$1 AND "partnerId"=$2 RETURNING 1',
      id, partnerId
    );
    if (!delRows?.length) return res.status(404).json({ error: "Not found" });
    return res.json({ deleted: true });
  } catch (e: any) {
    console.error("[PMS DELETE /connections/:id error]", e?.message || e);
    res.status(500).json({ error: "Internal", detail: String(e?.message || e) });
  }
});

/* --------------------------------- MAPPINGS -------------------------------- */

router.get("/mappings", async (req, res) => {
  try {
    const partnerId = getPartnerId(req);
    if (!partnerId || Number.isNaN(partnerId)) return res.status(401).json({ error: "Unauthorized" });

    if (hasDelegates()) {
      const rows = await (db as any).pmsMapping.findMany({
        where: { connection: { partnerId } },
        include: {
          connection: true,
          roomType: { select: { id: true, name: true } },
          ratePlan: { select: { id: true, name: true } },
        },
        orderBy: { id: "asc" },
      });
      return res.json(rows);
    }

    // RAW fallback (join for labels where present)
    const sql = `
      SELECT m.*,
             c."provider", c."mode", c."status" as "connectionStatus",
             rt."name" as "roomTypeName",
             rp."name" as "ratePlanName"
      FROM "extranet"."PmsMapping" m
      JOIN "extranet"."PmsConnection" c ON c."id" = m."pmsConnectionId" AND c."partnerId" = $1
      LEFT JOIN "extranet"."RoomType" rt ON rt."id" = m."localRoomTypeId"
      LEFT JOIN "extranet"."RatePlan" rp ON rp."id" = m."localRatePlanId"
      ORDER BY m."id" ASC`;
    const rows = await (db as any).$queryRawUnsafe(sql, partnerId);
    return res.json(rows);
  } catch (e: any) {
    console.error("[PMS GET /mappings error]", e?.message || e);
    res.status(500).json({ error: "Internal", detail: String(e?.message || e) });
  }
});

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

    if (hasDelegates()) {
      const conn = await (db as any).pmsConnection.findFirst({
        where: { id: Number(pmsConnectionId), partnerId },
      });
      if (!conn) return res.status(400).json({ error: "Invalid pmsConnectionId" });

      const created = await (db as any).pmsMapping.create({
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
      return res.json(created);
    }

    // RAW fallback: validate connection belongs to partner, then insert
    const connRows = await (db as any).$queryRawUnsafe(
      'SELECT "id" FROM "extranet"."PmsConnection" WHERE "id"=$1 AND "partnerId"=$2',
      Number(pmsConnectionId), partnerId
    );
    if (!connRows?.length) return res.status(400).json({ error: "Invalid pmsConnectionId" });

    const insSql = `
      INSERT INTO "extranet"."PmsMapping"
        ("pmsConnectionId","remoteRoomId","remoteRatePlanId","localRoomTypeId","localRatePlanId","currency","active","createdAt","updatedAt")
      VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW())
      RETURNING *;`;
    const rows = await (db as any).$queryRawUnsafe(
      insSql,
      Number(pmsConnectionId),
      String(remoteRoomId),
      remoteRatePlanId ? String(remoteRatePlanId) : null,
      toInt(localRoomTypeId) ?? null,
      toInt(localRatePlanId) ?? null,
      currency ?? null,
      !!active
    );
    return res.json(rows?.[0]);
  } catch (e: any) {
    console.error("[PMS POST /mappings error]", e?.message || e);
    res.status(500).json({ error: "Internal", detail: String(e?.message || e) });
  }
});

router.patch("/mappings/:id", async (req, res) => {
  try {
    const partnerId = getPartnerId(req);
    if (!partnerId || Number.isNaN(partnerId)) return res.status(401).json({ error: "Unauthorized" });
    const id = Number(req.params.id);
    const { localRoomTypeId, localRatePlanId, currency, active } = req.body ?? {};

    if (hasDelegates()) {
      const mapping = await (db as any).pmsMapping.findFirst({ where: { id, connection: { partnerId } } });
      if (!mapping) return res.status(404).json({ error: "Not found" });
      const updated = await (db as any).pmsMapping.update({
        where: { id },
        data: {
          localRoomTypeId: localRoomTypeId === undefined ? mapping.localRoomTypeId : toInt(localRoomTypeId),
          localRatePlanId: localRatePlanId === undefined ? mapping.localRatePlanId : toInt(localRatePlanId),
          currency: currency === undefined ? mapping.currency : currency,
          active: active === undefined ? mapping.active : !!active,
          updatedAt: new Date(),
        },
      });
      return res.json(updated);
    }

    // RAW fallback
    const updSql = `
      UPDATE "extranet"."PmsMapping"
      SET "localRoomTypeId" = COALESCE($2,"localRoomTypeId"),
          "localRatePlanId" = COALESCE($3,"localRatePlanId"),
          "currency" = COALESCE($4,"currency"),
          "active" = COALESCE($5,"active"),
          "updatedAt" = NOW()
      WHERE "id"=$1 AND "pmsConnectionId" IN (
        SELECT "id" FROM "extranet"."PmsConnection" WHERE "partnerId"=$6
      )
      RETURNING *;`;
    const rows = await (db as any).$queryRawUnsafe(
      updSql,
      id,
      localRoomTypeId === undefined ? null : toInt(localRoomTypeId),
      localRatePlanId === undefined ? null : toInt(localRatePlanId),
      currency === undefined ? null : currency,
      active === undefined ? null : !!active,
      partnerId
    );
    if (!rows?.length) return res.status(404).json({ error: "Not found" });
    return res.json(rows[0]);
  } catch (e: any) {
    console.error("[PMS PATCH /mappings/:id error]", e?.message || e);
    res.status(500).json({ error: "Internal", detail: String(e?.message || e) });
  }
});

router.delete("/mappings/:id", async (req, res) => {
  try {
    const partnerId = getPartnerId(req);
    if (!partnerId || Number.isNaN(partnerId)) return res.status(401).json({ error: "Unauthorized" });
    const id = Number(req.params.id);

    if (hasDelegates()) {
      const mapping = await (db as any).pmsMapping.findFirst({ where: { id, connection: { partnerId } } });
      if (!mapping) return res.status(404).json({ error: "Not found" });
      await (db as any).pmsMapping.delete({ where: { id } });
      return res.json({ deleted: true });
    }

    // RAW fallback
    const delSql = `
      DELETE FROM "extranet"."PmsMapping"
      WHERE "id"=$1 AND "pmsConnectionId" IN (
        SELECT "id" FROM "extranet"."PmsConnection" WHERE "partnerId"=$2
      )
      RETURNING 1;`;
    const rows = await (db as any).$queryRawUnsafe(delSql, id, partnerId);
    if (!rows?.length) return res.status(404).json({ error: "Not found" });
    return res.json({ deleted: true });
  } catch (e: any) {
    console.error("[PMS DELETE /mappings/:id error]", e?.message || e);
    res.status(500).json({ error: "Internal", detail: String(e?.message || e) });
  }
});

/* ----------------------------------- LOGS ---------------------------------- */

router.get("/logs", async (req, res) => {
  try {
    const partnerId = getPartnerId(req);
    if (!partnerId || Number.isNaN(partnerId)) return res.status(401).json({ error: "Unauthorized" });
    const limit = Math.min(200, Number(req.query.limit) || 50);

    if (hasDelegates()) {
      const rows = await (db as any).syncLog.findMany({
        where: { connection: { partnerId } },
        orderBy: { startedAt: "desc" },
        take: limit,
      });
      return res.json(rows);
    }

    // RAW fallback
    const sql = `
      SELECT s.*
      FROM "extranet"."SyncLog" s
      JOIN "extranet"."PmsConnection" c ON c."id" = s."pmsConnectionId"
      WHERE c."partnerId" = $1
      ORDER BY s."startedAt" DESC
      LIMIT $2;`;
    const rows = await (db as any).$queryRawUnsafe(sql, partnerId, limit);
    return res.json(rows);
  } catch (e: any) {
    console.error("[PMS GET /logs error]", e?.message || e);
    res.status(500).json({ error: "Internal", detail: String(e?.message || e) });
  }
});

export default router;
