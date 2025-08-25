import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { prisma } from "./prisma.js";

const app = express();

/* ----------------------- Security & parsing ----------------------- */
app.use(helmet());
const allowedOrigins = ["https://www.lolaelo.com"];
if (process.env.NODE_ENV !== "production") {
  allowedOrigins.push("http://localhost:3000"); // keep for local dev if needed
}
app.use(
  cors({
    origin(origin, cb) {
      // Allow non-browser / no-origin calls (curl, Hoppscotch agent)
      if (!origin) return cb(null, true);
      return allowedOrigins.includes(origin)
        ? cb(null, true)
        : cb(new Error("Not allowed by CORS"));
    }
  })
);
app.use(express.json());
app.use(morgan("tiny"));

/* ----------------------- Admin guard ----------------------- */
function adminGuard(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  const key = req.header("x-admin-key");
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

/* ----------------------- Root & Health ----------------------- */
app.get("/", (_req, res) => {
  res.send("Lolaelo API is running. See /health and /search.");
});
app.get("/health", (_req, res) => {
  res.json({ status: "ok", ts: new Date().toISOString() });
});

/* ----------------------- Demo Search (mock) ----------------------- */
const demoProperties = [
  {
    id: "prop_siargao_001",
    name: "Palm Cove Siargao",
    location: { city: "General Luna", island: "Siargao", country: "PH" },
    minPrice: 3500,
    currency: "PHP",
    images: ["https://picsum.photos/seed/siargao01/800/500"]
  },
  {
    id: "prop_siargao_002",
    name: "Cloud 9 Villas",
    location: { city: "General Luna", island: "Siargao", country: "PH" },
    minPrice: 4800,
    currency: "PHP",
    images: ["https://picsum.photos/seed/siargao02/800/500"]
  }
];
app.get("/search", (_req, res) => {
  res.json({ results: demoProperties, total: demoProperties.length });
});

/* ======================= WAITLIST ======================== */
app.post("/waitlist", async (req, res) => {
  try {
    const { email, phone } = req.body || {};
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: "Invalid email" });
    }
    const created = await prisma.waitlist.create({ data: { email, phone } });
    return res.status(201).json(created);
  } catch (err: any) {
    if (err?.code === "P2002") return res.status(409).json({ error: "Email already on waitlist" });
    return res.status(500).json({ error: "ServerError" });
  }
});
app.get("/waitlist", adminGuard, async (_req, res) => {
  const data = await prisma.waitlist.findMany({ orderBy: { createdAt: "desc" } });
  res.json({ total: data.length, data });
});

/* ================== PARTNER APPLICATIONS ================= */
app.post("/partners/applications", async (req, res) => {
  try {
    const { companyName, contactName, email, phone, notes } = req.body || {};
    if (!companyName || !contactName || !email) {
      return res.status(400).json({ error: "companyName, contactName, and email are required" });
    }
    const created = await prisma.partnerApplication.create({
      data: { companyName, contactName, email, phone, notes }
    });
    res.status(201).json(created);
  } catch {
    res.status(500).json({ error: "ServerError" });
  }
});
app.get("/partners/applications", adminGuard, async (_req, res) => {
  const data = await prisma.partnerApplication.findMany({ orderBy: { createdAt: "desc" } });
  res.json({ total: data.length, data });
});

/* ======================= CONTENT CMS ===================== */
app.put("/content/:key", adminGuard, async (req, res) => {
  try {
    const key = String(req.params.key || "").trim();
    const value = String((req.body?.value ?? "")).trim();
    if (!key || !value) return res.status(400).json({ error: "key and value are required" });

    const upserted = await prisma.contentBlock.upsert({
      where: { key },
      update: { value },
      create: { key, value }
    });
    res.json(upserted);
  } catch {
    res.status(500).json({ error: "ServerError" });
  }
});
app.get("/content/:key", async (req, res) => {
  const key = String(req.params.key || "").trim();
  const block = await prisma.contentBlock.findUnique({ where: { key } });
  if (!block) return res.status(404).json({ error: "NotFound" });
  res.json(block);
});

/* ----------------------- Start ----------------------- */
const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`API listening on :${port}`);
});
