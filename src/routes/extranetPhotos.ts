import { Router, Request, Response } from "express";
import { prisma } from "../prisma.js";
import { authPartnerFromHeader } from "../extranetAuth.js";
const router = Router();

export default router;

