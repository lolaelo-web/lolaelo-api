import { Router } from 'express';
import { PrismaClient, DocumentType, DocumentStatus } from '@prisma/client';
import { authPartnerFromHeader } from '../extranetAuth.js';

const prisma = new PrismaClient();
const router = Router();

// 1) Require auth (your existing helper)
router.use(authPartnerFromHeader);

// 2) Normalize partner id location from whatever the auth middleware sets
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
      return res.status(400).json({ error: 'type, key and url are required' });
    }

    // Coerce/validate enum
    const allTypes = Object.values(DocumentType);
    if (!allTypes.includes(type)) {
      const up = String(type).toUpperCase();
      if (!allTypes.includes(up as DocumentType)) {
        return res.status(400).json({ error: 'invalid_document_type' });
      }
      type = up;
    }

    // One-per-type per partner (schema has @@unique([partnerId, type]))
    const row = await prisma.propertyDocument.upsert({
      where: { partnerId_type: { partnerId, type } },
      update: {
        key,
        url,
        fileName,
        contentType,
        status: DocumentStatus.SUBMITTED,
        uploadedAt: new Date(),
        notes: null,
      },
      create: {
        partnerId,
        type,
        key,
        url,
        fileName,
        contentType,
        status: DocumentStatus.SUBMITTED,
      },
    });

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

  const { status, notes, expiresAt, type } = req.body || {};

  if (status && !Object.values(DocumentStatus).includes(status)) {
    return res.status(400).json({ error: 'invalid_status' });
  }
  if (type && !Object.values(DocumentType).includes(type)) {
    return res.status(400).json({ error: 'invalid_type' });
  }

  // ownership check
  const existing = await prisma.propertyDocument.findFirst({ where: { id, partnerId } });
  if (!existing) return res.status(404).json({ error: 'not_found' });

  try {
    const updated = await prisma.propertyDocument.update({
      where: { id },
      data: {
        status: status || undefined,
        notes: typeof notes === 'string' ? notes : undefined,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
        type: type || undefined,
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
