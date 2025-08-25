import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import { prisma } from "./prisma";

dotenv.config();

const app = express();
app.set("trust proxy", 1);

const PROD_ORIGIN = "https://www.lolaelo.com";
const DEV_ORIGIN = "http://localhost:3000";

app.use(helmet());
app.use(express.json());
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // curl/Hoppscotch Agent
      if (origin === PROD_ORIGIN || origin === DEV_ORIGIN) return cb(null, true);
      return cb(new Error("Not allowed by CORS"), false);
    },
    methods: ["GET", "POST", "PUT", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-admin-key"],
  })
);
app.use(morgan("tiny"));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

const ADMIN_KEY = process.env.ADMIN_KEY || "L0laEl0_Admin_2025!";

/* ------------------ Basic ------------------ */
app.get("/", (_req, res) => {
  res.send("Lolaelo API is running. See /health and /search.");
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", ts: new Date().toISOString() });
});

/* ------------------ Waitlist ------------------ */
app.post("/waitlist", async (req, res) => {
  try {
    const { email, phone } = req.body || {};
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: "Invalid email" });
    }

    const existing = await prisma.waitlist.findUnique({ where: { email } });
    if (existing) return res.status(409).json({ error: "AlreadyOnList" });

    const row = await prisma.waitlist.create({
      data: { email: email.trim(), phone: phone ? String(phone).trim() : null },
    });

    res.status(201).json({
      id: row.id,
      email: row.email,
      phone: row.phone,
      createdAt: row.createdAt,
    });
  } catch (err) {
    console.error("POST /waitlist error:", err);
    res.status(500).json({ error: "ServerError" });
  }
});

app.get("/waitlist", async (req, res) => {
  try {
    const key = req.header("x-admin-key");
    if (key !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });

    const rows = await prisma.waitlist.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    res.json({ total: rows.length, data: rows });
  } catch (err) {
    console.error("GET /waitlist error:", err);
    res.status(500).json({ error: "ServerError" });
  }
});

/* -------------- Partners: Applications -------------- */
app.post("/partners/applications", async (req, res) => {
  try {
    const { companyName, contactName, email, phone, location, notes } = req.body || {};

    if (!companyName || typeof companyName !== "string" || companyName.trim() === "")
      return res.status(400).json({ error: "Invalid companyName" });

    if (!contactName || typeof contactName !== "string" || contactName.trim() === "")
      return res.status(400).json({ error: "Invalid contactName" });

    if (!email || !/^\S+@\S+\.\S+$/.test(email))
      return res.status(400).json({ error: "Invalid email" });

    if (!phone || typeof phone !== "string" || phone.trim().length < 5)
      return res.status(400).json({ error: "Invalid phone" });

    if (!location || typeof location !== "string" || location.trim().length < 3)
      return res.status(400).json({ error: "Invalid location" });

    const row = await prisma.partnerApplication.create({
      data: {
        companyName: companyName.trim(),
        contactName: contactName.trim(),
        email: email.trim(),
        phone: phone.trim(),
        location: location.trim(),
        notes: notes ? String(notes).trim() : null,
      },
    });

    res.status(201).json({
      id: row.id,
      companyName: row.companyName,
      contactName: row.contactName,
      email: row.email,
      phone: row.phone,
      location: row.location,
      notes: row.notes,
      createdAt: row.createdAt,
    });
  } catch (err) {
    console.error("POST /partners/applications error:", err);
    res.status(500).json({ error: "ServerError" });
  }
});

app.get("/partners/applications", async (req, res) => {
  try {
    const key = req.header("x-admin-key");
    if (key !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });

    const rows = await prisma.partnerApplication.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    res.json({ total: rows.length, data: rows });
  } catch (err) {
    console.error("GET /partners/applications error:", err);
    res.status(500).json({ error: "ServerError" });
  }
});

/* ------------------ Content via ContentBlock ------------------ */
// Admin upsert
app.put("/content/:key", async (req, res) => {
  try {
    const adminKey = req.header("x-admin-key");
    if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });

    const contentKey = String(req.params.key);
    const value = String(req.body?.value ?? "");

    const row = await prisma.contentBlock.upsert({
      where: { key: contentKey },
      update: { value },
      create: { key: contentKey, value },
    });

    res.json({
      key: row.key,
      value: row.value,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  } catch (err) {
    console.error("PUT /content/:key error:", err);
    res.status(500).json({ error: "ServerError" });
  }
});

// Public read
app.get("/content/:key", async (req, res) => {
  try {
    const contentKey = String(req.params.key);
    const row = await prisma.contentBlock.findUnique({ where: { key: contentKey } });
    if (!row) return res.status(404).json({ error: "NotFound" });
    res.json({ key: row.key, value: row.value, updatedAt: row.updatedAt });
  } catch (err) {
    console.error("GET /content/:key error:", err);
    res.status(500).json({ error: "ServerError" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`API listening on :${PORT}`);
});
