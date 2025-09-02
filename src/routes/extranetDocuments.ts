import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { authPartnerFromHeader } from '../extranetAuth.js';

const prisma = new PrismaClient();
const router = Router();

/** Allowed enums (mirror prisma schema) */
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
type DocType = (typeof ALLOWED_TYPES)[number];

const ALLOWED_STATUSES = ['REQUIRED', 'SUBMITTED', 'APPROVED', 'REJECTED'] as const;
type DocStatus = (typeof ALLOWED_STATUSES)[number];

/** Type guards */
function toDocType(v: unknown): DocType | null {
  const s = String(v ?? '').toUpperCase() as DocType;
  return ALLOWED_TYPES.includes(s) ? s : null;
}
function toDocStatus(v: unknown): DocStatus | null {
  const s = String(v ?? '').toUpperCase() as DocStatus;
  return ALLOWED_STATUSES.includes(s) ? s : null;
}

/** Auth */
router.use(authPartnerFromHeader);

/** Normalize partner id (prefer same source as photos) */
router.use((req: any, res, next) => {
  const pid =
    res.locals?.partner?.id ??
    res.locals?.partnerId ??
    req?.partner?.id ??
    req?.partnerId ??
    req?.user?.partnerId ??
    null;

  if (!pid) return res.status(401).json({ error: 'unauthorized_no_partner' });
  req.__pid = Number(pid);
  next();
});

/** GET /extranet/property/documents */
router.get('/', async (req: any, res) => {
  const partnerId = req.__pid;
  const rows = await prisma.propertyDocument.findMany({
    where: { partnerId },
    orderBy: [{ type: 'asc' }, { uploadedAt: 'desc' }],
  });
  return res.json(rows);
});

/** POST /extranet/property/documents
 *  body: { type, key, url, fileName?, contentType? }
 */
router.post('/', async (req: any, res) => {
  const partnerId = req.__pid;
  let { type, key, url, fileName, contentType } = req.body ?? {};

  if (!type || !key || !url) {
    return res.status(400).json({ error: 'type_key_url_required' });
  }

  const normalizedType = toDocType(type);
  if (!normalizedType) {
    return res.status(400).json({
      error: 'invalid_document_type',
      got: type,
      allowed: ALLOWED_TYPES,
    });
  }

  try {
    // one-per-type per partner
    const existing = await prisma.propertyDocument.findFirst({
      where: { partnerId, type: normalizedType },
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
          status: 'SUBMITTED', // DocStatus
          uploadedAt: new Date(),
          notes: null,
        },
      });
    } else {
      row = await prisma.propertyDocument.create({
        data: {
          partnerId,
          type: normalizedType,
          key,
          url,
          fileName,
          contentType,
          status: 'SUBMITTED', // DocStatus
        },
      });
    }

    return res.json(row);
  } catch (e: any) {
    // Surface prisma details to diagnose quickly
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

/** PUT /extranet/property/documents/:id
 *  body: { status?, notes?, expiresAt?, type? }
 */
router.put('/:id', async (req: any, res) => {
  const partnerId = req.__pid;
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad_id' });

  let { status, notes, expiresAt, type } = req.body ?? {};

  let normalizedStatus: DocStatus | undefined;
  if (status !== undefined) {
    const s = toDocStatus(status);
    if (!s) return res.status(400).json({ error: 'invalid_status', allowed: ALLOWED_STATUSES });
    normalizedStatus = s;
  }

  let normalizedType: DocType | undefined;
  if (type !== undefined) {
    const t = toDocType(type);
    if (!t) return res.status(400).json({ error: 'invalid_type', allowed: ALLOWED_TYPES });
    normalizedType = t;
  }

  // ownership check
  const existing = await prisma.propertyDocument.findFirst({ where: { id, partnerId } });
  if (!existing) return res.status(404).json({ error: 'not_found' });

  try {
    const updated = await prisma.propertyDocument.update({
      where: { id },
      data: {
        status: normalizedStatus ?? undefined,
        notes: typeof notes === 'string' ? notes : undefined,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
        type: normalizedType ?? undefined,
        verifiedAt: normalizedStatus === 'APPROVED' ? new Date() : undefined,
      },
    });
    return res.json(updated);
  } catch (e: any) {
    console.error('update document error:', e);
    return res.status(400).json({ error: 'update_failed' });
  }
});

/** DELETE /extranet/property/documents/:id */
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
