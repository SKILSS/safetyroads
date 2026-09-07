const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { pool } = require("./db");

const router = express.Router();

function issueToken(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: "7d" });
}

router.post("/register", async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password || password.length < 8) {
      return res.status(400).json({ error: "Email and a password of at least 8 characters are required." });
    }
    const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email.toLowerCase()]);
    if (existing.rows[0]) return res.status(409).json({ error: "An account with this email already exists." });

    const hash = bcrypt.hashSync(password, 12);
    const result = await pool.query(
      "INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'user') RETURNING id, email, role",
      [email.toLowerCase(), hash]
    );
    const user = result.rows[0];
    res.status(201).json({ token: issueToken(user), user: { email: user.email, role: user.role } });
  } catch (err) {
    next(err);
  }
});

router.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Email and password required." });

    const result = await pool.query("SELECT * FROM users WHERE email = $1", [email.toLowerCase()]);
    const user = result.rows[0];
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: "Invalid email or password." });
    }
    res.json({ token: issueToken(user), user: { email: user.email, role: user.role } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;