import { Router } from "express";

const r = Router();

/**
 * Minimal, crash-proof Rooms router for verification.
 * GET -> [] (empty list)
 * POST -> 201 with echoed payload + fake id
 */

r.get("/", async (_req, res) => {
  try {
    return res.status(200).json([]); // prove route mounts
  } catch (e) {
    console.error("[rooms:get] error", e);
    return res.status(500).json({ error: "Rooms list failed" });
  }
});

r.post("/", async (req, res) => {
  try {
    const { name, occupancy, code, description } = req.body ?? {};
    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "name is required" });
    }
    const payload = {
      id: Math.floor(Math.random() * 1_000_000),
      name,
      occupancy: occupancy == null ? 2 : Number(occupancy),
      code: code ?? null,
      description: description ?? null,
      _note: "dummy create (router is mounted)",
    };
    return res.status(201).json(payload);
  } catch (e) {
    console.error("[rooms:post] error", e);
    return res.status(500).json({ error: "Create failed" });
  }
});

export default r;
