const express = require("express");
const argon2 = require("argon2");
const jwt = require("jsonwebtoken");
const { pool } = require("../db");
const { optionalAuth } = require("../middleware/auth");

const router = express.Router();
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict",
  path: "/",
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

function issueToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function publicUser(user) {
  return { id: user.id, email: user.email, role: user.role };
}

async function verifyPassword(password, storedHash) {
  // New accounts use Argon2id. Existing bcrypt hashes are upgraded at login.
  if (String(storedHash).startsWith("$argon2")) {
    return { ok: await argon2.verify(storedHash, password), needsUpgrade: false };
  }
  const bcrypt = require("bcryptjs"); // temporary compatibility for old accounts
  const ok = bcrypt.compareSync(password, storedHash);
  return { ok, needsUpgrade: ok };
}

async function hashPassword(password) {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
}

router.post("/register", async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password || password.length < 8) {
      return res.status(400).json({ error: "Email and a password of at least 8 characters are required." });
    }
    const normalized = email.toLowerCase().trim();
    const existing = await pool.query("SELECT id FROM users WHERE email = $1", [normalized]);
    if (existing.rows[0]) return res.status(409).json({ error: "An account with this email already exists." });

    const hash = await hashPassword(password);
    const result = await pool.query(
      "INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'user') RETURNING id, email, role",
      [normalized, hash]
    );
    const user = result.rows[0];
    res.cookie("session", issueToken(user), COOKIE_OPTIONS);
    res.status(201).json({ user: publicUser(user) });
  } catch (err) { next(err); }
});

router.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Email and password required." });

    const result = await pool.query("SELECT * FROM users WHERE email = $1", [email.toLowerCase().trim()]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: "Invalid email or password." });

    const checked = await verifyPassword(password, user.password_hash);
    if (!checked.ok) return res.status(401).json({ error: "Invalid email or password." });

    if (checked.needsUpgrade) {
      const newHash = await hashPassword(password);
      await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [newHash, user.id]);
    }

    res.cookie("session", issueToken(user), COOKIE_OPTIONS);
    res.json({ user: publicUser(user) });
  } catch (err) { next(err); }
});

router.get("/me", optionalAuth, (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Not authenticated." });
  res.json({ user: publicUser(req.user) });
});

router.post("/logout", (req, res) => {
  res.clearCookie("session", { ...COOKIE_OPTIONS, maxAge: undefined });
  res.json({ ok: true });
});

module.exports = router;
