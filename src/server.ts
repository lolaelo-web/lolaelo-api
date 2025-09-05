import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

/** ESM output requires .js suffixes */
import extranetAuth from "./routes/extranetAuth.js";
import extranetRooms from "./routes/extranetRooms.js";
import extranetProperty from "./routes/extranetProperty.js";
import extranetPhotos from "./routes/extranetPhotos.js";
import photosUploadUrl from "./routes/extranetPhotosUploadUrl.js";
import extranetDocuments from "./routes/extranetDocuments.js";
import documentsUploadUrl from "./routes/extranetDocumentsUploadUrl.js";

process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));

const app = express();

app.set("trust proxy", 1);
app.use(express.json({ limit: "10mb" }));

// Static
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const pubPath    = path.join(__dirname, "..", "public");
app.use("/public", express.static(pubPath, { maxAge: "1h", etag: true }));
app.use(express.static(pubPath, { extensions: ["html"], maxAge: "1h", etag: true }));

// CORS
const ALLOWED_ORIGINS = [
  "https://lolaelo.com",
  "https://www.lolaelo.com",
  "https://lolaelo-web.github.io",
  // "http://localhost:5173",
  // "http://127.0.0.1:5173",
];
app.use(cors({
  origin: (origin, cb) => (!origin || ALLOWED_ORIGINS.includes(origin)) ? cb(null, true) : cb(null, false),
  methods: ["GET","POST","PUT","PATCH","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization","x-partner-token","Accept"],
}));

// Health (bump text so we can verify deploy)
app.get("/health", (_req, res) => res.status(200).send("OK v-ROUTES-3"));

// Mount routers
app.use("/extranet/property/photos/upload-url", photosUploadUrl);
app.use("/extranet/property/photos", extranetPhotos);
app.use("/extranet/property/documents/upload-url", documentsUploadUrl);
app.use("/extranet/property/documents", extranetDocuments);
app.use("/extranet/property/rooms", extranetRooms);
app.use("/extranet/property", extranetProperty);
app.use(extranetAuth); // /extranet/session, /extranet/logout, etc.

// Route list (debug)
app.get("/__routes", (req, res) => {
  const stack: any[] = (req.app as any)?._router?.stack ?? [];
  const routes = stack
    .filter((l: any) => l.route)
    .map((l: any) => ({ path: l.route.path, methods: Object.keys(l.route.methods) }));
  res.json({ routes });
});

// 404 + error handler
app.use((req, res) => res.status(404).json({ error: "Not Found", path: req.path }));
// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal Server Error" });
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
export default app;
