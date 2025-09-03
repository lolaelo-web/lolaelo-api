import { Router } from "express";
import { prisma } from "../prisma.js";
import { z } from "zod";
import { authPartnerFromHeader } from "../extranetAuth.js";
const requirePartner: any = authPartnerFromHeader;

const router = Router();

/** ---------- Schemas ---------- */
const roomTypeCreateSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  maxGuests: z.number().int().min(1).max(16).default(2),
  basePrice: z.union([z.number(), z.string()]).transform((v: number | string) => v.toString()),
});

const roomTypeUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  maxGuests: z.number().int().min(1).max(16).optional(),
  basePrice: z
    .union([z.number(), z.string()])
    .optional()
    .transform((v: number | string | undefined | null) => (v == null ? undefined : v.toString())),
});

const rangeSchema = z.object({
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const inventoryBulkSchema = rangeSchema.extend({
  roomsOpen: z.number().int().min(0),
  isClosed: z.boolean().optional().default(false),
  minStay: z.number().int().min(1).optional(),
});

const pricesBulkSchema = rangeSchema.extend({
  price: z.union([z.number(), z.string()]).transform((v: number | string) => v.toString()),
  ratePlanId: z.number().int().nullable().optional(),
});

/** ---------- Helpers ---------- */
function* eachDateUTC(startISO: string, endISO: string) {
  const start = new Date(startISO + "T00:00:00.000Z");
  const end = new Date(endISO + "T00:00:00.000Z");
  if (end < start) throw new Error("end < start");
  for (let d = new Date(start); d <= end; d = new Date(d.getTime() + 86400000)) {
    yield new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }
}

async function getOrCreateBaseRatePlan(partnerId: number, roomTypeId: number) {
  const name = "Base";
  let rp = await prisma.ratePlan.findFirst({ where: { partnerId, roomTypeId, name } });
  if (!rp) {
    rp = await prisma.ratePlan.create({
      data: { partnerId, roomTypeId, name, policy: null, priceDelta: "0.00" },
    });
  }
  return rp;
}

/** ---------- Room Types CRUD ---------- */

// GET /extranet/property/rooms
router.get("/", requirePartner, async (req: any, res) => {
  const partnerId = Number(req.partner?.id ?? req.partnerId);
  const roomTypes = await prisma.roomType.findMany({
    where: { partnerId },
    orderBy: [{ id: "asc" }],
    include: { rates: true },
  });
  res.json(roomTypes);
});

// POST /extranet/property/rooms
router.post("/", requirePartner, async (req: any, res) => {
  const partnerId = Number(req.partner?.id ?? req.partnerId);
  const body = roomTypeCreateSchema.parse(req.body);

  const created = await prisma.roomType.create({
    data: {
      partnerId,
      name: body.name,
      description: body.description ?? null,
      maxGuests: body.maxGuests,
      basePrice: body.basePrice,
    },
  });

  await getOrCreateBaseRatePlan(partnerId, created.id);
  res.status(201).json(created);
});

// PUT /extranet/property/rooms/:id
router.put("/:id", requirePartner, async (req: any, res) => {
  const partnerId = Number(req.partner?.id ?? req.partnerId);
  const id = Number(req.params.id);
  const body = roomTypeUpdateSchema.parse(req.body);

  const exists = await prisma.roomType.findFirst({ where: { id, partnerId } });
  if (!exists) return res.status(404).json({ error: "Not found" });

  const updated = await prisma.roomType.update({
    where: { id },
    data: {
      name: body.name ?? undefined,
      description: body.description ?? undefined,
      maxGuests: body.maxGuests ?? undefined,
      basePrice: body.basePrice ?? undefined,
    },
  });

  res.json(updated);
});

// DELETE /extranet/property/rooms/:id
router.delete("/:id", requirePartner, async (req: any, res) => {
  const partnerId = Number(req.partner?.id ?? req.partnerId);
  const id = Number(req.params.id);

  const exists = await prisma.roomType.findFirst({ where: { id, partnerId } });
  if (!exists) return res.status(404).json({ error: "Not found" });

  await prisma.roomType.delete({ where: { id } });
  res.status(204).end();
});

/** ---------- Inventory ---------- */

// POST /extranet/property/rooms/:roomTypeId/inventory/bulk
router.post("/:roomTypeId/inventory/bulk", requirePartner, async (req: any, res) => {
  const partnerId = Number(req.partner?.id ?? req.partnerId);
  const roomTypeId = Number(req.params.roomTypeId);
  const body = inventoryBulkSchema.parse(req.body);

  const rt = await prisma.roomType.findFirst({ where: { id: roomTypeId, partnerId } });
  if (!rt) return res.status(404).json({ error: "RoomType not found" });

  const ops: any[] = [];
  for (const d of eachDateUTC(body.start, body.end)) {
    ops.push(
      prisma.roomInventory.upsert({
        where: { roomTypeId_date: { roomTypeId, date: d } },
        create: {
          partnerId,
          roomTypeId,
          date: d,
          roomsOpen: body.roomsOpen,
          isClosed: body.isClosed ?? false,
          minStay: body.minStay ?? null,
        },
        update: {
          roomsOpen: body.roomsOpen,
          isClosed: body.isClosed ?? false,
          minStay: body.minStay ?? null,
        },
      })
    );
  }

  // Use array transaction without extra options (TS-safe on Prisma v5)
  await prisma.$transaction(ops as any);
  res.json({ ok: true, count: ops.length });
});

// GET /extranet/property/rooms/:roomTypeId/inventory
router.get("/:roomTypeId/inventory", requirePartner, async (req: any, res) => {
  const partnerId = Number(req.partner?.id ?? req.partnerId);
  const roomTypeId = Number(req.params.roomTypeId);
  const q = rangeSchema.parse({ start: req.query.start, end: req.query.end });

  const rt = await prisma.roomType.findFirst({ where: { id: roomTypeId, partnerId } });
  if (!rt) return res.status(404).json({ error: "RoomType not found" });

  const rows = await prisma.roomInventory.findMany({
    where: {
      partnerId,
      roomTypeId,
      date: { gte: new Date(q.start + "T00:00:00.000Z"), lte: new Date(q.end + "T00:00:00.000Z") },
    },
    orderBy: [{ date: "asc" }],
  });

  res.json(rows);
});

/** ---------- Prices ---------- */

// POST /extranet/property/rooms/:roomTypeId/prices/bulk
router.post("/:roomTypeId/prices/bulk", requirePartner, async (req: any, res) => {
  const partnerId = Number(req.partner?.id ?? req.partnerId);
  const roomTypeId = Number(req.params.roomTypeId);
  const body = pricesBulkSchema.parse(req.body);

  const rt = await prisma.roomType.findFirst({ where: { id: roomTypeId, partnerId } });
  if (!rt) return res.status(404).json({ error: "RoomType not found" });

  let ratePlanId = body.ratePlanId ?? null;
  if (ratePlanId == null) {
    const base = await getOrCreateBaseRatePlan(partnerId, roomTypeId);
    ratePlanId = base.id;
  } else {
    const rp = await prisma.ratePlan.findFirst({ where: { id: ratePlanId, partnerId, roomTypeId } });
    if (!rp) return res.status(400).json({ error: "Invalid ratePlanId" });
  }

  const ops: any[] = [];
  for (const d of eachDateUTC(body.start, body.end)) {
    ops.push(
      prisma.roomPrice.upsert({
        where: { roomTypeId_ratePlanId_date: { roomTypeId, ratePlanId, date: d } },
        create: {
          partnerId,
          roomTypeId,
          ratePlanId,
          date: d,
          price: body.price,
        },
        update: { price: body.price },
      })
    );
  }

  // Use array transaction without extra options (TS-safe on Prisma v5)
  await prisma.$transaction(ops as any);
  res.json({ ok: true, count: ops.length });
});

// GET /extranet/property/rooms/:roomTypeId/prices
router.get("/:roomTypeId/prices", requirePartner, async (req: any, res) => {
  const partnerId = Number(req.partner?.id ?? req.partnerId);
  const roomTypeId = Number(req.params.roomTypeId);
  const q = rangeSchema.parse({ start: req.query.start, end: req.query.end });

  const rt = await prisma.roomType.findFirst({ where: { id: roomTypeId, partnerId } });
  if (!rt) return res.status(404).json({ error: "RoomType not found" });

  const rows = await prisma.roomPrice.findMany({
    where: {
      partnerId,
      roomTypeId,
      date: { gte: new Date(q.start + "T00:00:00.000Z"), lte: new Date(q.end + "T00:00:00.000Z") },
    },
    orderBy: [{ date: "asc" }],
  });

  res.json(rows);
});

export default router;
