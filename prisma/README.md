# Prisma Baseline & Migration Runbook

## ⚠️ READ THIS BEFORE TOUCHING `schema.prisma`

This project uses a **baselined Prisma setup**.

The production database schema is authoritative and Prisma has been aligned to it.
Improper Prisma commands or schema changes can corrupt migration history.

If you are about to:
- edit `schema.prisma`
- add or modify a model
- run any Prisma migration command

**STOP and read this document first.**

---

## 🧠 Canonical Design Decisions (LOCKED)

### Schemas
- **extranet** is the ONLY authoritative schema
- **public** is legacy and inert
  - CREATE is revoked
  - Do not add models or migrations to public
  - public may exist physically but must never be used

### Prisma Datasource
```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
  schemas  = ["extranet"]
}
