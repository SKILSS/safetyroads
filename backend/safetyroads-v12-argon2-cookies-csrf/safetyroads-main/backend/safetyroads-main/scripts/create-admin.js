// Run once after deploying: npm run create-admin
// Reads ADMIN_EMAIL / ADMIN_PASSWORD from .env, creates (or promotes) that
// user to role='admin'. This is the ONLY way an admin account gets made —
// the public /register endpoint always creates plain 'user' accounts.
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
for (const f of ["/etc/secrets/safetyroads.env", path.join(process.cwd(), "safetyroads.env")]) {
  if (fs.existsSync(f)) dotenv.config({ path: f, override: false });
}
dotenv.config({ override: false });
const argon2 = require("argon2");
const { pool, initSchema } = require("../db");

async function main() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.error("Set ADMIN_EMAIL and ADMIN_PASSWORD in .env first.");
    process.exit(1);
  }
  await initSchema();
  const hash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
  await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'admin')
     ON CONFLICT (email) DO UPDATE SET password_hash = $2, role = 'admin'`,
    [email.toLowerCase(), hash]
  );
  console.log(`Admin account ready: ${email}`);
  await pool.end();
}
main().catch((err) => { console.error(err); process.exit(1); });

