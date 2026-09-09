require("dotenv").config();
const bcrypt = require("bcryptjs");
const { pool, initSchema } = require("../db");

async function ensureAdmin() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.warn("ADMIN_EMAIL/ADMIN_PASSWORD are not set; skipping admin bootstrap.");
    return;
  }
  const hash = bcrypt.hashSync(password, 12);
  await pool.query(
    `INSERT INTO users (email, password_hash, role)
     VALUES ($1, $2, 'admin')
     ON CONFLICT (email)
     DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'admin'`,
    [email.toLowerCase(), hash]
  );
  console.log(`Admin account ready: ${email}`);
}

module.exports = { ensureAdmin };
