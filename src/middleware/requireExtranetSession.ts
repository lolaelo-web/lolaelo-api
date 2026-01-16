import type { Request, Response, NextFunction } from "express";
import { prisma } from "../prisma.js";

export type ExtranetSessionData = {
  token: string;
  partnerId: number;
  email: string;
  name?: string | null;
};

declare global {
  namespace Express {
    interface Request {
      extranet?: ExtranetSessionData;
    }
  }
}

export async function requireExtranetSession(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    // ---- Extract token -------------------------------------------------------
    const auth = req.header("authorization") || req.header("Authorization");
    const legacy = req.header("x-partner-token");
    let token: string | null = null;

    if (auth && auth.startsWith("Bearer ")) {
      token = auth.slice("Bearer ".length).trim();
    } else if (legacy) {
      token = legacy.trim();
    }

    if (!token) {
      return res.status(401).json({ message: "Missing bearer token" });
    }

    // ---- Fetch session via VIEW (read-only) ----------------------------------
    const rows = await prisma.$queryRaw<any[]>`
      SELECT
        id,
        "partnerId",
        token,
        "expiresAt",
        "createdAt",
        "revokedAt",
        "lastSeenAt"
      FROM extranet."ExtranetSession"
      WHERE token = ${token}
      LIMIT 1
    `;

    const session = rows?.[0];
    if (!session) {
      return res.status(401).json({ message: "Session not found" });
    }

    if (session.revokedAt) {
      return res.status(401).json({ message: "Session revoked" });
    }

    if (session.expiresAt && new Date(session.expiresAt) < new Date()) {
      return res.status(401).json({ message: "Session expired" });
    }

    // ---- Inactivity timeout (30 minutes) ------------------------------------
    const INACTIVITY_MS = 30 * 60 * 1000;
    const HEARTBEAT_MS = 2 * 60 * 1000;

    const nowMs = Date.now();
    const lastSeenMs = session.lastSeenAt
      ? new Date(session.lastSeenAt).getTime()
      : new Date(session.createdAt).getTime();

    const idleMs = nowMs - lastSeenMs;

    if (idleMs > INACTIVITY_MS) {
      // Revoke in storage table
      await prisma.$executeRaw`
        UPDATE extranet."ExtranetSession"
        SET "revokedAt" = now()
        WHERE token = ${token}
      `;
      return res.status(401).json({ message: "Session expired (inactive)" });
    }

    // ---- Throttled heartbeat update -----------------------------------------
    if (idleMs > HEARTBEAT_MS) {
      await prisma.$executeRaw`
        UPDATE extranet."ExtranetSession"
        SET "lastSeenAt" = now()
        WHERE token = ${token}
      `;
    }

    // ---- Load partner --------------------------------------------------------
    const partner = await prisma.extranet_Partner.findUnique({
      where: { id: session.partnerId },
    });

    if (!partner) {
      return res.status(401).json({ message: "Partner not found" });
    }

    // ---- Attach to request ---------------------------------------------------
    req.extranet = {
      token,
      partnerId: partner.id,
      email: partner.email,
      name: partner.name,
    };

    return next();
  } catch (err) {
    console.error("requireExtranetSession error", err);
    return res.status(401).json({ message: "Unauthorized" });
  }
}
