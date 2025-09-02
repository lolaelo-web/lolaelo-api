import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { authPartnerFromHeader } from '../extranetAuth.js';

const prisma = new PrismaClient();
const router = Router();

// Allowed values (mirror your Prisma schema)
const ALLOWED_TYPES = [
  'GOVT_ID',
  'BUSINESS_REG',
  'TAX_ID',
  'BANK_PROOF',
  'PROOF_OF_ADDRESS',
  'INSURANCE_LIABILITY',
  'PROPERTY_OWNERSHIP',
  'LOCAL_LICENSE',
] as const;
type DocType = typeof ALLOWED_TYPES[number];

const ALLOWED_STATUSES = ['REQUIRED', 'SUBMITTED', 'APPROVED', 'REJECTED'] as const;
type DocStatus = typeof ALLOWED_STATUSES[number];

// --- Auth ---
router.use(authPartnerFromHeader);

// 2) Normalize partner id (prefer the same source that photos uses)
router.use((req: any, res, next) => {
  const pid =
    res.locals?.partner?.id ??        // 1) primary: same object photos populates
    res.locals?.partnerId ??          // 2) explicit partnerId in locals
    req?.partner?.id ??               // 3) some middlewares attach here
    req?.partnerId ??                 // 4) or here
    req?.user?.partnerId ??           // 5) fallback: token/session field (can be stale)
    null;

  if (!pid) return res.status(401).json({ error: 'unauthorized_no_partner' });
  req.__pid = Number(pid);
  next();
});

// GET /extranet/property/documents
router.get('/', async (req: any, res) => {
  const partnerId = req.__pid;
  const rows = await prisma.propertyDocument.findMany({
    where: { partnerId },
    orderBy: [{ type: 'asc' }, { uploadedAt: 'desc' }],
  });
  return res.json(rows);
});

// POST /extranet/property/documents
// expects { type, key, url, fileName?, contentType? }
router.post('/', async (req: any, res) => {
  const partnerId = req.__pid;
  let { type, key, url, fileName, contentType } = req.body || {};

  if (!type || !key || !url) {
    return res.status(400).json({ error: 'type_key_url_required' });
  }

  // Coerce/validate enum
  const allTypes = Object.values(DocumentType);
  if (!allTypes.includes(type)) {
    const up = String(type).toUpperCase();
    if (!allTypes.includes(up as DocumentType)) {
      return res.status(400).json({ error: 'invalid_document_type', got: type, allowed: allTypes });
    }
    type = up;
  }

  try {
    // allow one-per-type per partner
    const existing = await prisma.propertyDocument.findFirst({
      where: { partnerId, type },
    });

    let row;
    if (existing) {
      row = await prisma.propertyDocument.update({
        where: { id: existing.id },
        data: {
          key,
          url,
          fileName,
          contentType,
          status: 'SUBMITTED',
          uploadedAt: new Date(),
          notes: null,
        },
      });
    } else {
      row = await prisma.propertyDocument.create({
        data: {
          partnerId,
          type,
          key,
          url,
          fileName,
          contentType,
          status: 'SUBMITTED',
        },
      });
    }

    return res.json(row);
  } catch (e: any) {
    // TEMP: surface prisma details so we can diagnose quickly
    console.error('create document error:', {
      message: e?.message,
      code: e?.code,
      meta: e?.meta,
    });

    const payload: any = {
      error: 'create_failed',
      code: e?.code ?? null,
      message: e?.message ?? null,
      meta: e?.meta ?? null,
    };
    if (e?.code === 'P2002') payload.conflict = e?.meta?.target ?? null;
    return res.status(400).json(payload);
  }
});

// PUT /extranet/property/documents/:id
// accepts { status?, notes?, expiresAt?, type? }
router.put('/:id', async (req: any, res) => {
  const partnerId = req.__pid;
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad_id' });

  let { status, notes, expiresAt, type } = req.body || {};

  if (status) {
    const s = String(status).toUpperCase();
    if (!ALLOWED_STATUSES.includes(s as DocStatus)) {
      return res.status(400).json({ error: 'invalid_status' });
    }
    status = s;
  }

  if (type) {
    const t = String(type).toUpperCase();
    if (!ALLOWED_TYPES.includes(t as DocType)) {
      return res.status(400).json({ error: 'invalid_type' });
    }
    type = t;
  }

  // ownership check
  const existing = await prisma.propertyDocument.findFirst({ where: { id, partnerId } });
  if (!existing) return res.status(404).json({ error: 'not_found' });

  try {
    const updated = await prisma.propertyDocument.update({
      where: { id },
      data: {
        status: (status as any) || undefined,
        notes: typeof notes === 'string' ? notes : undefined,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
        type: (type as any) || undefined,
        verifiedAt: status === 'APPROVED' ? new Date() : undefined,
      },
    });
    return res.json(updated);
  } catch (e: any) {
    console.error('update document error:', e);
    return res.status(400).json({ error: 'update_failed' });
  }
});

// DELETE /extranet/property/documents/:id
router.delete('/:id', async (req: any, res) => {
  const partnerId = req.__pid;
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad_id' });

  const existing = await prisma.propertyDocument.findFirst({ where: { id, partnerId } });
  if (!existing) return res.status(404).json({ error: 'not_found' });

  await prisma.propertyDocument.delete({ where: { id } });
  return res.status(204).end();
});

export default router;
