import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";

// Prisma client (note the .js extension for ESM at runtime)
import { prisma } from "./prisma.js";

const app = express();

// --- Middleware ---
app.use(helmet());
app.use(cors()); // we'll lock to https://www.lolaelo.com later
app.use(express.json());
app.use(morgan("tiny"));

// --- Simple admin guard (temporary) ---
function adminGuard(req: express.Request, res: express.Response, next: express.NextFunction) {
  const key = req.header("x-admin-key");
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// --- Root ---
app.get("/", (_req, res) => {
  res.send("Lolaelo API is running. See /health and /search.");
});

// --- Healthcheck ---
app.get("/health", (_req, res) => {
  res.json({ status: "ok", ts: new Date().toISOString() });
});

// --- Demo search (mock data for UI hookup) ---
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

// ===============================
// WAITLIST (DB-backed via Prisma)
// ===============================

// POST /waitlist  { email, phone? }
app.post("/waitlist", async (req, res) => {
  try {
    const { email, phone } = req.body || {};

    // very light validation
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: "Invalid email" });
    }

    const created = await prisma.waitlist.create({ data: { email, phone } });
    return res.status(201).json(created);
  } catch (err: any) {
    // Unique constraint (email already exists)
    if (err?.code === "P2002") {
      return res.status(409).json({ error: "Email already on waitlist" });
    }
    return res.status(500).json({ error: "ServerError" });
  }
});

// GET /waitlist  (admin only)
app.get("/waitlist", adminGuard, async (_req, res) => {
  const data = await prisma.waitlist.findMany({ orderBy: { createdAt: "desc" } });
  res.json({ total: data.length, data });
});

// --- Start server ---
const port = process.env.PORT || 10000; // Render injects PORT
app.listen(port, () => {
  console.log(`API listening on :${port}`);
});
