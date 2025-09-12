### 2025-09-11 — Verification

- __ping → { ok: true }
- UIS counts → Direct: 3, PMS: 6
- Notes: PMS mock mirrors extranet.RoomInventory; end date is exclusive.


### Ops guardrails (perpetuity)
- Start command on Render: **\
pm run start:prod\** (runs \prisma migrate deploy\ before boot).
- Build command: **\
pm ci && npm run build\**.
- Line endings: **LF** enforced via \.gitattributes\; \.editorconfig\ set to UTF-8 (no BOM).
- JSON/SQ L/MD are normalized to **LF**, BOM-free.
- PMS mock mirrors **extranet.RoomInventory** (schema-qualified) to avoid delegate drift.
- End date in UIS queries is **exclusive**.
- Before suggesting edits to any file, **review the entire file in chat first**.
