import { Router, type Response } from "express";
import { v4 as uuidv4 } from "uuid";
import {
  readUsers, writeUsers, hashPassword, checkPassword,
  signToken, verifyToken, requireAuth, requireAdmin, type AuthRequest, type User
} from "../lib/auth.js";

const router = Router();

// POST /api/auth/register
router.post("/register", (req, res: Response): void => {
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    res.status(400).json({ error: "Username, email and password are required." }); return;
  }
  if (username.length < 3) {
    res.status(400).json({ error: "Username must be at least 3 characters." }); return;
  }
  if (password.length < 6) {
    res.status(400).json({ error: "Password must be at least 6 characters." }); return;
  }

  const users = readUsers();

  if (users.find(u => u.email.toLowerCase() === email.toLowerCase())) {
    res.status(400).json({ error: "Email already registered." }); return;
  }
  if (users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
    res.status(400).json({ error: "Username already taken." }); return;
  }

  const role: "admin" | "user" = users.length === 0 ? "admin" : "user";

  const newUser: User = {
    id: uuidv4(), username, email,
    passwordHash: hashPassword(password),
    role, createdAt: new Date().toISOString(),
  };

  users.push(newUser);
  writeUsers(users);

  const { passwordHash, ...safeUser } = newUser;
  const token = signToken(safeUser);
  res.json({ token, user: safeUser });
});

// POST /api/auth/login
router.post("/login", (req, res: Response): void => {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required." }); return;
  }

  const users = readUsers();
  const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());

  if (!user || !checkPassword(password, user.passwordHash)) {
    res.status(401).json({ error: "Invalid email or password." }); return;
  }

  const { passwordHash, ...safeUser } = user;
  const token = signToken(safeUser);
  res.json({ token, user: safeUser });
});

// ── Admin user management ──────────────────────────────────────────────────────

// GET /api/auth/admin/users
router.get("/admin/users", requireAdmin as any, (req: AuthRequest, res: Response): void => {
  const users = readUsers();
  const safe = users.map(({ passwordHash, ...u }) => u);
  res.json({ users: safe });
});

// POST /api/auth/admin/users - create user
router.post("/admin/users", requireAdmin as any, (req: AuthRequest, res: Response): void => {
  const { username, email, password, role } = req.body;
  if (!username || !email || !password) {
    res.status(400).json({ error: "username, email and password required." }); return;
  }
  if (username.length < 3) {
    res.status(400).json({ error: "Username must be at least 3 characters." }); return;
  }
  if (password.length < 6) {
    res.status(400).json({ error: "Password must be at least 6 characters." }); return;
  }

  const users = readUsers();
  if (users.find(u => u.email.toLowerCase() === email.toLowerCase())) {
    res.status(400).json({ error: "Email already registered." }); return;
  }
  if (users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
    res.status(400).json({ error: "Username already taken." }); return;
  }

  const newUser: User = {
    id: uuidv4(), username, email,
    passwordHash: hashPassword(password),
    role: role === "admin" ? "admin" : "user",
    createdAt: new Date().toISOString(),
  };
  users.push(newUser);
  writeUsers(users);

  const { passwordHash, ...safe } = newUser;
  res.json({ user: safe });
});

// PATCH /api/auth/admin/users/:id/role
router.patch("/admin/users/:id/role", requireAdmin as any, (req: AuthRequest, res: Response): void => {
  const { role } = req.body;
  if (role !== "admin" && role !== "user") {
    res.status(400).json({ error: "Role must be 'admin' or 'user'." }); return;
  }

  const users = readUsers();
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) { res.status(404).json({ error: "User not found." }); return; }

  users[idx].role = role as "admin" | "user";
  writeUsers(users);

  const { passwordHash, ...safe } = users[idx];
  res.json({ user: safe });
});

// PATCH /api/auth/admin/users/:id/password
router.patch("/admin/users/:id/password", requireAdmin as any, (req: AuthRequest, res: Response): void => {
  const { password } = req.body;
  if (!password || password.length < 6) {
    res.status(400).json({ error: "Password must be at least 6 characters." }); return;
  }

  const users = readUsers();
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) { res.status(404).json({ error: "User not found." }); return; }

  users[idx].passwordHash = hashPassword(password);
  writeUsers(users);
  res.json({ ok: true });
});

// DELETE /api/auth/admin/users/:id
router.delete("/admin/users/:id", requireAdmin as any, (req: AuthRequest, res: Response): void => {
  if (req.user?.id === req.params.id) {
    res.status(400).json({ error: "Cannot delete yourself." }); return;
  }

  let users = readUsers();
  const before = users.length;
  users = users.filter(u => u.id !== req.params.id);
  if (users.length === before) { res.status(404).json({ error: "User not found." }); return; }

  writeUsers(users);
  res.json({ ok: true });
});

// GET /api/auth/me
router.get("/me", (req: AuthRequest, res: Response): void => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) { res.status(401).json({ error: "Not authenticated." }); return; }

  const user = verifyToken(token);
  if (!user) { res.status(401).json({ error: "Invalid or expired token." }); return; }

  res.json({ user });
});

export default router;
