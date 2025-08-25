import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";

const app = express();
app.use(helmet());
app.use(cors()); // later restrict: cors({ origin: ["https://<your-site>"] })
app.use(express.json());
app.use(morgan("tiny"));

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

app.get("/search", (req, res) => {
  // later: use req.query (dates, guests, city) to filter
  res.json({ results: demoProperties, total: demoProperties.length });
});

// --- Root (optional) ---
app.get("/", (_req, res) => {
  res.send("Lolaelo API is running. See /health and /search.");
});

const port = process.env.PORT || 10000; // Render sets PORT for you
app.listen(port, () => {
  console.log(`API listening on :${port}`);
});
