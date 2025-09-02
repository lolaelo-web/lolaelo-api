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

// Normalize partner id from whatever the auth helper set
router.use((req: any, res, next) => {
  const pid =
    req?.user?.partnerId ??
    res.locals?.partnerId ??
    res.locals?.partner?.id ??
    req?.partner?.id ??
    req?.partnerId ??
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
  try {
    const partnerId = req.__pid;
    let { type, key, url, fileName, contentType } = req.body || {};

    if (!type || !key || !url) {
      return res.status(400).json({ error: 'type_key_url_required' });
    }

    // Coerce & validate type (string)
    const t = String(type).toUpperCase();
    if (!ALLOWED_TYPES.includes(t as DocType)) {
      return res.status(400).json({ error: 'invalid_document_type' });
    }

    // One-per-type per partner: update if exists, else create
    const existing = await prisma.propertyDocument.findFirst({
      where: { partnerId, type: t as any },
    });

    let row;
    if (existing) {
      row = await prisma.propertyDocument.update({
        where: { id: existing.id },
        data: {
          key,
          url,
          fileName: fileName ?? undefined,
          contentType: contentType ?? undefined,
          status: 'SUBMITTED' as any,
          uploadedAt: new Date(),
          notes: null,
        },
      });
    } else {
      row = await prisma.propertyDocument.create({
        data: {
          partnerId,
          type: t as any,
          key,
          url,
          fileName: fileName ?? undefined,
          contentType: contentType ?? undefined,
          status: 'SUBMITTED' as any,
        },
      });
    }

    return res.json(row);
  } catch (e: any) {
    console.error('create document error:', e);
    return res.status(400).json({ error: 'create_failed' });
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
