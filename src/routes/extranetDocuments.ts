import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { authPartnerFromHeader } from '../extranetAuth.js';

const prisma = new PrismaClient();
const router = Router();

/** Prisma enums are *types*, not runtime values.
 *  Define the allowed strings explicitly for runtime validation. */
const DOC_TYPES = [
  'GOVT_ID',
  'BUSINESS_REG',
  'TAX_ID',
  'BANK_PROOF',
  'PROOF_OF_ADDRESS',
  'INSURANCE_LIABILITY',
  'PROPERTY_OWNERSHIP',
  'LOCAL_LICENSE',
] as const;
type DocType = (typeof DOC_TYPES)[number];

const STATUSES = ['REQUIRED', 'SUBMITTED', 'APPROVED', 'REJECTED'] as const;
type DocStatus = (typeof STATUSES)[number];

const isOneOf = <T extends string>(arr: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && arr.includes(v as T);

// 1) Require auth (existing helper)
router.use(authPartnerFromHeader);

// 2) Normalize partner id from whatever the auth middleware sets
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
  const partnerId = req.__pid as number;
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
    const partnerId = req.__pid as number;
    let { type, key, url, fileName, contentType } = req.body ?? {};

    if (!type || !key || !url) {
      return res.status(400).json({ error: 'type, key and url are required' });
    }

    // Coerce/validate DocumentType
    const cand = String(type).toUpperCase();
    if (!isOneOf(DOC_TYPES, cand)) {
      return res.status(400).json({ error: 'invalid_document_type' });
    }
    const docType: DocType = cand;

    // One-per-type per partner (schema has @@unique([partnerId, type]))
const existing = await prisma.propertyDocument.findFirst({
  where: { partnerId, type: type as any },
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
      status: DocumentStatus.SUBMITTED,
      uploadedAt: new Date(),
      notes: null,
    },
  });
} else {
  row = await prisma.propertyDocument.create({
    data: {
      partnerId,
      type: type as any,
      key,
      url,
      fileName: fileName ?? undefined,
      contentType: contentType ?? undefined,
      status: DocumentStatus.SUBMITTED,
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
  const partnerId = req.__pid as number;
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad_id' });

  const { status, notes, expiresAt, type } = req.body ?? {};

  if (status && !isOneOf(STATUSES, status)) {
    return res.status(400).json({ error: 'invalid_status' });
  }
  if (type && !isOneOf(DOC_TYPES, type)) {
    return res.status(400).json({ error: 'invalid_type' });
  }

  // ownership check
  const existing = await prisma.propertyDocument.findFirst({ where: { id, partnerId } });
  if (!existing) return res.status(404).json({ error: 'not_found' });

  try {
    const updated = await prisma.propertyDocument.update({
      where: { id },
      data: {
        status: (status as DocStatus) || undefined,
        notes: typeof notes === 'string' ? notes : undefined,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
        type: (type as DocType) || undefined,
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
  const partnerId = req.__pid as number;
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad_id' });

  const existing = await prisma.propertyDocument.findFirst({ where: { id, partnerId } });
  if (!existing) return res.status(404).json({ error: 'not_found' });

  await prisma.propertyDocument.delete({ where: { id } });
  return res.status(204).end();
});

export default router;
