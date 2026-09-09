// Run once after deploying: npm run create-admin
// Reads ADMIN_EMAIL / ADMIN_PASSWORD from .env, creates (or promotes) that
// user to role='admin'. This is the ONLY way an admin account gets made —
// the public /register endpoint always creates plain 'user' accounts.
require("dotenv").config();
const bcrypt = require("bcryptjs");
const { pool, initSchema } = require("../../db");

async function main() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.error("Set ADMIN_EMAIL and ADMIN_PASSWORD in .env first.");
    process.exit(1);
  }
  await initSchema();
  const hash = bcrypt.hashSync(password, 12);
  await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'admin')
     ON CONFLICT (email) DO UPDATE SET password_hash = $2, role = 'admin'`,
    [email.toLowerCase(), hash]
  );
  console.log(`Admin account ready: ${email}`);
  await pool.end();
}
main().catch((err) => { console.error(err); process.exit(1); });
