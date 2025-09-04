import { prisma } from "../prisma.js";
export async function requireExtranetSession(req, res, next) {
    try {
        const auth = req.header("authorization") || req.header("Authorization");
        const legacy = req.header("x-partner-token");
        let token = null;
        if (auth && auth.startsWith("Bearer "))
            token = auth.slice("Bearer ".length).trim();
        else if (legacy)
            token = legacy.trim();
        if (!token)
            return res.status(401).json({ message: "Missing bearer token" });
        const session = await prisma.extranetSession.findUnique({ where: { token } });
        if (!session)
            return res.status(401).json({ message: "Session not found" });
        if (session.revokedAt)
            return res.status(401).json({ message: "Session revoked" });
        if (session.expiresAt && session.expiresAt < new Date())
            return res.status(401).json({ message: "Session expired" });
        const partner = await prisma.partner.findUnique({ where: { id: session.partnerId } });
        if (!partner)
            return res.status(401).json({ message: "Partner not found" });
        req.extranet = {
            token,
            partnerId: partner.id,
            email: partner.email,
            name: partner.name,
        };
        next();
    }
    catch (err) {
        console.error("requireExtranetSession error", err);
        return res.status(401).json({ message: "Unauthorized" });
    }
}
