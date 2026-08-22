import "dotenv/config";
import bcrypt from "bcryptjs";
import { pool } from "./db/pool.js";

const email = (process.env.SEED_ADMIN_EMAIL ?? "admin@example.com").toLowerCase();
const password = process.env.SEED_ADMIN_PASSWORD ?? "changeme123";
const name = process.env.SEED_ADMIN_NAME ?? "Admin";

async function run() {
  const { rows } = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
  if (rows[0]) {
    console.log(`Admin user ${email} already exists, skipping.`);
    await pool.end();
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await pool.query(
    `INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, 'admin')`,
    [email, passwordHash, name]
  );

  console.log(`Created admin user: ${email}`);
  if (!process.env.SEED_ADMIN_PASSWORD) {
    console.log(
      `Using default password "${password}" — set SEED_ADMIN_PASSWORD to override, and change it after first login.`
    );
  }
  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
