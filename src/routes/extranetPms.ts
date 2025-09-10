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

/* ======================================================================
   PUBLIC DIAGNOSTICS  (no auth; must be defined BEFORE any auth middleware)
   ====================================================================== */

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

router.get("/__routes_public", (_req, res) => {
  try {
    const stack: any[] = ((router as any).stack ?? []).filter((l: any) => l?.route);
    const routes = stack.map((l: any) => ({
      path: l.route?.path,
      methods: l.route ? Object.keys(l.route.methods) : [],
    }));
    res.json({ ok: true, routes });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.get("/__dbping_public", async (_req, res) => {
  try {
    if (hasDelegates()) {
      const one = await (db as any).roomType.findMany({ take: 1, select: { id: true } });
      return res.json({ ok: true, via: "delegate", sample: one });
    } else {
      const rows: any = await (db as any).$queryRawUnsafe(
        `SELECT current_user, current_schema, NOW() as now, 1 as one`
      );
      return res.json({ ok: true, via: "raw", rows });
    }
  } catch (e: any) {
    return res.json({ ok: false, via: hasDelegates() ? "delegate" : "raw", error: String(e?.message || e) });
  }
});

/* ======================================================================
   AUTH (per-route)
   ====================================================================== */

async function requirePartner(req: any, res: any, next: any) {
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
    req.partnerId = session.partnerId;
    next();
  } catch (e: any) {
    console.error("[PMS auth error]", e?.message || e);
    return res.status(401).json({ error: "Unauthorized" });
  }
}

/* ======================================================================
   HELPERS
   ====================================================================== */

function toInt(v: any) {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}
function getPartnerId(req: any) {
  return Number(req.partnerId);
}
/** treat delegates as present only if ALL three exist (keeps fallback coherent) */
function hasDelegates() {
  const anyDb: any = db;
  return (
    typeof anyDb?.pmsConnection?.findMany === "function" &&
    typeof anyDb?.pmsMapping?.findMany === "function" &&
    typeof anyDb?.syncLog?.findMany === "function"
  );
}

/* ======================================================================
   PRIVATE: WHOAMI
   ====================================================================== */

router.get("/whoami", requirePartner, (req, res) => {
  res.json({ ok: true, partnerId: Number((req as any).partnerId) || null });
});

/* ======================================================================
   CONNECTIONS
   ====================================================================== */

router.get("/connections", requirePartner, async (req, res) => {
  try {
    const partnerId = getPartnerId(req);

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

router.post("/connections", requirePartner, async (req, res) => {
  try {
    const partnerId = getPartnerId(req);

    if (!Number.isFinite(partnerId)) {
      return res.status(401).json({ error: "no partner session" });
    }

    // Ensure Partner row exists for this exact id (FK for PmsConnection)
    // Prisma can't create with a fixed autoinc id; use RAW insert.
    await (db as any).$executeRawUnsafe(
      `INSERT INTO "extranet"."Partner" ("id","name","email","createdAt","updatedAt")
      VALUES ($1,$2,$3,NOW(),NOW())
      ON CONFLICT ("id") DO NOTHING`,
      partnerId,
      `Partner ${partnerId}`,
      `partner${partnerId}@local`
    );

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

    // RAW fallback
    // (Also ensure Partner exists in RAW path in case delegates are not present)
    await (db as any).$executeRawUnsafe(
      `INSERT INTO "extranet"."Partner" ("id","name","email","createdAt","updatedAt")
      VALUES ($1,$2,$3,NOW(),NOW())
      ON CONFLICT ("id") DO NOTHING`,
      partnerId,
      `Partner ${partnerId}`,
      `partner${partnerId}@local`
    );

    const upsertSql = `
      INSERT INTO "extranet"."PmsConnection"
        ("partnerId","provider","mode","status","scope","createdAt","updatedAt")
      VALUES ($1,$2,$3,$4,$5, NOW(), NOW())
      ON CONFLICT ("partnerId","provider")
      DO UPDATE SET "mode" = EXCLUDED."mode",
                    "status" = EXCLUDED."status",
                    "scope" = EXCLUDED."scope",
                    "updatedAt" = NOW()
      RETURNING *;`;
    const rows = await (db as any).$queryRawUnsafe(upsertSql, partnerId, provider, mode, status, scope);
    const conn = rows?.[0];

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

router.patch("/connections/:id", requirePartner, async (req, res) => {
  try {
    const partnerId = getPartnerId(req);
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
      RETURNING *;`;
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

router.post("/connections/:id/test", requirePartner, async (req, res) => {
  try {
    const partnerId = getPartnerId(req);
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
      id,
      partnerId
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
      id,
      ok ? "SUCCESS" : "ERROR",
      ok ? "Mock connection test passed" : "Mock connection test failed"
    );
    const updated = await (db as any).$queryRawUnsafe('SELECT * FROM "extranet"."PmsConnection" WHERE "id"=$1', id);
    return res.json({ ok, connection: updated?.[0], logStatus: ok ? "SUCCESS" : "ERROR" });
  } catch (e: any) {
    console.error("[PMS POST /connections/:id/test error]", e?.message || e);
    res.status(500).json({ error: "Internal", detail: String(e?.message || e) });
  }
});

router.delete("/connections/:id", requirePartner, async (req, res) => {
  try {
    const partnerId = getPartnerId(req);
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
      id,
      partnerId
    );
    if (!delRows?.length) return res.status(404).json({ error: "Not found" });
    return res.json({ deleted: true });
  } catch (e: any) {
    console.error("[PMS DELETE /connections/:id error]", e?.message || e);
    res.status(500).json({ error: "Internal", detail: String(e?.message || e) });
  }
});

/* ======================================================================
   MAPPINGS
   ====================================================================== */

router.get("/mappings", requirePartner, async (req, res) => {
  try {
    const partnerId = getPartnerId(req);

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

    // RAW fallback
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

router.post("/mappings", requirePartner, async (req, res) => {
  try {
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

    // RAW fallback
    const connRows = await (db as any).$queryRawUnsafe(
      'SELECT "id" FROM "extranet"."PmsConnection" WHERE "id"=$1 AND "partnerId"=$2',
      Number(pmsConnectionId),
      partnerId
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

router.patch("/mappings/:id", requirePartner, async (req, res) => {
  try {
    const partnerId = getPartnerId(req);
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

router.delete("/mappings/:id", requirePartner, async (req, res) => {
  try {
    const partnerId = getPartnerId(req);
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

/* ======================================================================
   LOGS
   ====================================================================== */

router.get("/logs", requirePartner, async (req, res) => {
  try {
    const partnerId = getPartnerId(req);
    const limit = Math.min(Math.max(Number(req.query.limit ?? 10), 1), 100);

    if (hasDelegates()) {
      const rows = await (db as any).syncLog.findMany({
        where: { connection: { partnerId } },
        orderBy: [{ id: "desc" }],
        take: limit,
      });
      return res.json(rows);
    }

    // RAW fallback
    const rows = await (db as any).$queryRawUnsafe(
      `
      SELECT l.*
      FROM "extranet"."SyncLog" l
      JOIN "extranet"."PmsConnection" c ON c."id" = l."pmsConnectionId"
      WHERE c."partnerId" = $1
      ORDER BY l."id" DESC
      LIMIT $2
      `,
      partnerId,
      limit
    );
    return res.json(rows);
  } catch (e: any) {
    console.error("[PMS GET /logs error]", e?.message || e);
    res.status(500).json({ error: "Internal", detail: String(e?.message || e) });
  }
});

/* ======================================================================
   MOCK REMOTE FIXTURES
   ====================================================================== */

router.get("/remote/rooms", requirePartner, async (req, res) => {
  try {
    const partnerId = Number((req as any).partnerId);

    let mappings: any[] = [];
    if (hasDelegates()) {
      mappings = await (db as any).pmsMapping.findMany({
        where: { active: true, connection: { partnerId } },
        orderBy: { id: "asc" },
      });
    } else {
      mappings = await (db as any).$queryRawUnsafe(
        `SELECT m.* FROM "extranet"."PmsMapping" m
         JOIN "extranet"."PmsConnection" c ON c."id" = m."pmsConnectionId"
         WHERE m."active" = TRUE AND c."partnerId" = $1
         ORDER BY m."id" ASC`,
        partnerId
      );
    }

    const rooms = mappings.map((m) => ({
      connectionId: m.pmsConnectionId,
      remoteRoomId: String(m.remoteRoomId),
      remoteRatePlanId: m.remoteRatePlanId ? String(m.remoteRatePlanId) : null,
      name: `Mock Room ${m.remoteRoomId}`,
      description: "Mock PMS room (fixture)",
      maxGuests: 2,
      currency: m.currency ?? "USD",
      active: !!m.active,
      source: "pms",
    }));

    res.json(rooms);
  } catch (e: any) {
    console.error("[PMS GET /remote/rooms error]", e?.message || e);
    res.status(500).json({ error: "Internal", detail: String(e?.message || e) });
  }
});

router.get("/remote/availability", requirePartner, async (req, res) => {
  try {
    const partnerId = Number((req as any).partnerId);

    const startStr = String(req.query.start ?? "");
    const endStr = String(req.query.end ?? "");
    const start = new Date(startStr);
    const end = new Date(endStr);
    if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf()) || end <= start) {
      return res.status(400).json({ error: "Invalid date range" });
    }

    let mappings: any[] = [];
    if (hasDelegates()) {
      mappings = await (db as any).pmsMapping.findMany({
        where: { active: true, connection: { partnerId } },
        orderBy: { id: "asc" },
      });
    } else {
      mappings = await (db as any).$queryRawUnsafe(
        `SELECT m.* FROM "extranet"."PmsMapping" m
         JOIN "extranet"."PmsConnection" c ON c."id" = m."pmsConnectionId"
         WHERE m."active" = TRUE AND c."partnerId" = $1
         ORDER BY m."id" ASC`,
        partnerId
      );
    }

    const days: string[] = [];
    for (
      let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
      d < end;
      d.setUTCDate(d.getUTCDate() + 1)
    ) {
      days.push(d.toISOString().slice(0, 10));
    }

    const out: any[] = [];
    mappings.forEach((m) => {
      days.forEach((ds, idx) => {
        out.push({
          connectionId: m.pmsConnectionId,
          remoteRoomId: String(m.remoteRoomId),
          remoteRatePlanId: m.remoteRatePlanId ? String(m.remoteRatePlanId) : null,
          date: ds,
          roomsOpen: 3,
          price: 120 + (idx % 5) * 10,
          currency: m.currency ?? "USD",
          source: "pms",
        });
      });
    });

    res.json(out);
  } catch (e: any) {
    console.error("[PMS GET /remote/availability error]", e?.message || e);
    res.status(500).json({ error: "Internal", detail: String(e?.message || e) });
  }
});

/* ======================================================================
   UIS SEARCH MERGE
   ====================================================================== */

router.get("/uis/search", requirePartner, async (req, res) => {
  try {
    const partnerId = Number((req as any).partnerId);

    const startStr = String(req.query.start ?? "");
    const endStr = String(req.query.end ?? "");
    const guests = Number(req.query.guests ?? 2);

    const start = new Date(startStr);
    const end = new Date(endStr);
    if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf()) || end <= start) {
      return res.status(400).json({ error: "Invalid date range" });
    }

    // Date list [start, end)
    const days: string[] = [];
    for (
      let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
      d < end;
      d.setUTCDate(d.getUTCDate() + 1)
    ) {
      days.push(d.toISOString().slice(0, 10));
    }

    /* -------- EXTRANET: room types, inventory, min price per date -------- */
    let rts: any[] = [];
    let inv: any[] = [];
    let prices: any[] = [];
    try {
      rts = await (db as any).roomType.findMany({
        where: { partnerId, maxGuests: { gte: Number.isNaN(guests) ? 1 : guests } },
        select: { id: true, name: true, maxGuests: true, partnerId: true },
      });
      inv = await (db as any).roomInventory.findMany({
        where: { partnerId, date: { gte: start, lt: end }, isClosed: false, roomsOpen: { gt: 0 } },
        select: { roomTypeId: true, date: true, roomsOpen: true },
      });
      prices = await (db as any).roomPrice.findMany({
        where: { partnerId, date: { gte: start, lt: end } },
        select: { roomTypeId: true, ratePlanId: true, date: true, price: true },
      });
    } catch {
      rts = []; inv = []; prices = [];
    }

    const rtIndex = new Map<number, { id: number; name: string; maxGuests: number }>();
    rts.forEach((rt) => rtIndex.set(rt.id, rt));

    const extranet: any[] = [];
    const minPrice = new Map<string, { price: any; ratePlanId: number | null }>();
    for (const p of prices) {
      const key = `${p.roomTypeId}|${new Date(p.date).toISOString().slice(0, 10)}`;
      const prev = minPrice.get(key);
      if (!prev || Number(p.price) < Number(prev.price)) {
        minPrice.set(key, { price: p.price, ratePlanId: p.ratePlanId ?? null });
      }
    }
    for (const iv of inv) {
      const dateStr = new Date(iv.date).toISOString().slice(0, 10);
      if (!days.includes(dateStr)) continue;
      const rt = rtIndex.get(iv.roomTypeId);
      if (!rt) continue;
      const mp = minPrice.get(`${iv.roomTypeId}|${dateStr}`);
      if (!mp) continue;
      extranet.push({
        source: "direct",
        date: dateStr,
        roomTypeId: rt.id,
        ratePlanId: mp.ratePlanId,
        name: rt.name,
        maxGuests: rt.maxGuests,
        price: mp.price,
        currency: "USD",
      });
    }

    /* ----------------------- PMS (mock via mappings) ---------------------- */
    let mappings: any[] = [];
    if (hasDelegates()) {
      mappings = await (db as any).pmsMapping.findMany({
        where: { active: true, connection: { partnerId } },
        orderBy: { id: "asc" },
      });
    } else {
      mappings = await (db as any).$queryRawUnsafe(
        `SELECT m.* FROM "extranet"."PmsMapping" m
         JOIN "extranet"."PmsConnection" c ON c."id" = m."pmsConnectionId"
         WHERE m."active" = TRUE AND c."partnerId" = $1
         ORDER BY m."id" ASC`,
        partnerId
      );
    }

    const pms: any[] = [];
    mappings.forEach((m) => {
      days.forEach((ds, idx) => {
        pms.push({
          source: "pms",
          date: ds,
          connectionId: m.pmsConnectionId,
          remoteRoomId: String(m.remoteRoomId),
          remoteRatePlanId: m.remoteRatePlanId ? String(m.remoteRatePlanId) : null,
          name: `Mock Room ${m.remoteRoomId}`,
          maxGuests: 2,
          price: 120 + (idx % 5) * 10,
          currency: m.currency ?? "USD",
        });
      });
    });

    res.status(200).json({ extranet, pms });
  } catch (e: any) {
    console.error("[UIS GET /uis/search error]", e?.message || e);
    res.status(500).json({ error: "Internal", detail: String(e?.message || e) });
  }
});

/* ======================================================================
   PRIVATE DIAGNOSTICS (auth)
   ====================================================================== */

router.get("/__routes", requirePartner, (_req, res) => {
  try {
    const stack: any[] = ((router as any).stack ?? []).filter((l: any) => l?.route);
    const routes = stack.map((l: any) => ({
      path: l.route?.path,
      methods: l.route ? Object.keys(l.route.methods) : [],
    }));
    res.json({ ok: true, routes });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.get("/__dbping", requirePartner, async (_req, res) => {
  try {
    if (hasDelegates()) {
      const one = await (db as any).roomType.findMany({ take: 1, select: { id: true } });
      return res.json({ ok: true, via: "delegate", sample: one });
    } else {
      const rows: any = await (db as any).$queryRawUnsafe(`SELECT current_user, current_schema, NOW() as now, 1 as one`);
      return res.json({ ok: true, via: "raw", rows });
    }
  } catch (e: any) {
    return res.json({ ok: false, via: hasDelegates() ? "delegate" : "raw", error: String(e?.message || e) });
  }
});

export default router;
