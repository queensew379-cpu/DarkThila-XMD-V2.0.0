import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USERS_FILE = path.join(__dirname, "../../../sessions/users.json");
const JWT_SECRET = process.env.JWT_SECRET || "dark-thila-super-secret-2025";
const JWT_EXPIRES = "7d";

export interface User {
  id: string;
  username: string;
  email: string;
  passwordHash: string;
  role: "admin" | "user";
  createdAt: string;
}

// ── File helpers ──────────────────────────────────────────────────────────────
export const readUsers = (): User[] => {
  try {
    if (!fs.existsSync(USERS_FILE)) return [];
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf-8"));
  } catch { return []; }
};

export const writeUsers = (users: User[]) => {
  const dir = path.dirname(USERS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
};

// ── Auth helpers ──────────────────────────────────────────────────────────────
export const hashPassword = (pw: string) => bcrypt.hashSync(pw, 10);
export const checkPassword = (pw: string, hash: string) => bcrypt.compareSync(pw, hash);
export const signToken = (user: Omit<User, "passwordHash">) =>
  jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES });

export const verifyToken = (token: string): Omit<User, "passwordHash"> | null => {
  try { return jwt.verify(token, JWT_SECRET) as Omit<User, "passwordHash">; }
  catch { return null; }
};

// ── Middleware ────────────────────────────────────────────────────────────────
export interface AuthRequest extends Request {
  user?: Omit<User, "passwordHash">;
}

export const requireAuth = (req: AuthRequest, res: Response, next: NextFunction): void => {
  const token = req.headers.authorization?.replace("Bearer ", "") || (req.cookies as any)?.token;
  if (!token) { res.status(401).json({ error: "Not authenticated" }); return; }
  const user = verifyToken(token);
  if (!user) { res.status(401).json({ error: "Invalid or expired token" }); return; }
  req.user = user;
  next();
};

export const requireAdmin = (req: AuthRequest, res: Response, next: NextFunction): void => {
  requireAuth(req, res, () => {
    if (req.user?.role !== "admin") { res.status(403).json({ error: "Admin access required" }); return; }
    next();
  });
};
