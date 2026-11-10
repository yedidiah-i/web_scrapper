/**
 * Bootstrap the gateway ledger with the admin account and an API key.
 *
 *   node scripts/seed.mjs
 *
 * Environment:
 *   GATEWAY_DB_PATH   where the SQLite ledger lives
 *   ADMIN_EMAIL       admin account email   (default yedidiah@scrapeworks.com)
 *   ADMIN_PASSWORD    admin account password (default: same as the email)
 *   ADMIN_NAME        admin display name     (default Yedidiah)
 *   ADMIN_TIER        hobby|professional|enterprise
 *   SEED_DEMO         also seed a demo account when "1" or "true"
 *   DEMO_EMAIL        demo account email     (default demo@scrapeworks.local)
 *   DEMO_PASSWORD     demo account password  (default demo-password-1234)
 *
 * Running the script twice is safe: an existing admin keeps its password and
 * a fresh API key is issued each time.
 */
import { createHash, randomBytes, scryptSync } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const dbPath =
  process.env.GATEWAY_DB_PATH ?? path.join(process.cwd(), "data", "gateway.db");

const adminEmail = (process.env.ADMIN_EMAIL ?? "yedidiah@scrapeworks.com").toLowerCase();
const adminPassword = process.env.ADMIN_PASSWORD ?? adminEmail;
const adminName = process.env.ADMIN_NAME ?? "Yedidiah";
const adminTier = process.env.ADMIN_TIER ?? "enterprise";

const demoEnabled = /^(1|true|yes)$/i.test(process.env.SEED_DEMO ?? "");
const demoEmail = (process.env.DEMO_EMAIL ?? "demo@scrapeworks.local").toLowerCase();
const demoPassword = process.env.DEMO_PASSWORD ?? "demo-password-1234";

const TIERS = {
  hobby: { credits: 5_000, rate: 30, concurrent: 2 },
  professional: { credits: 25_000, rate: 120, concurrent: 8 },
  enterprise: { credits: 150_000, rate: 600, concurrent: 32 },
};

function hashPassword(value) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(value, salt, 64).toString("hex")}`;
}

function hashApiKey(value) {
  return createHash("sha256").update(value).digest("hex");
}

mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec(readFileSync(path.join(process.cwd(), "db", "schema.sql"), "utf8"));

// Keep the ledger in step with lib/db.ts when the schema gains columns.
const columns = new Set(
  db
    .prepare("PRAGMA table_info(users)")
    .all()
    .map((row) => row.name),
);

if (!columns.has("role")) {
  db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
}

if (!columns.has("last_login_at")) {
  db.exec("ALTER TABLE users ADD COLUMN last_login_at INTEGER");
}

/**
 * Provision an account.
 *
 * Returns the user id plus the freshly issued API key.
 */
function provision({ email, name, password, tier, role }) {
  const plan = TIERS[tier] ?? TIERS.professional;
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);

  let userId;
  let created = false;

  if (existing) {
    userId = existing.id;
    // Make sure an existing account carries the role it should have.
    db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, userId);
    console.log(`user already exists: ${email} (role ${role})`);
  } else {
    const result = db
      .prepare(
        `INSERT INTO users
           (email, name, password_hash, tier, role, monthly_credits,
            rate_limit_per_minute, concurrent_limit, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        email,
        name,
        hashPassword(password),
        tier,
        role,
        plan.credits,
        plan.rate,
        plan.concurrent,
        Date.now(),
      );
    userId = Number(result.lastInsertRowid);
    created = true;
    console.log(`created user ${email} (${tier} tier, ${role} role)`);
  }

  const plaintext = `sk_live_${randomBytes(24).toString("base64url")}`;
  const prefix = `${plaintext.slice(0, 12)}...${plaintext.slice(-4)}`;

  db.prepare(
    `INSERT INTO api_keys (user_id, label, key_prefix, key_hash, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(userId, created ? "seed" : "seed-reset", prefix, hashApiKey(plaintext), Date.now());

  return { userId, plaintext };
}

const admin = provision({
  email: adminEmail,
  name: adminName,
  password: adminPassword,
  tier: adminTier,
  role: "admin",
});

console.log("");
console.log("  dashboard login :", adminEmail, "/", adminPassword);
console.log("  api key         :", admin.plaintext);
console.log("  ledger          :", dbPath);
console.log("");

let demo = null;
if (demoEnabled) {
  demo = provision({
    email: demoEmail,
    name: "Demo Operator",
    password: demoPassword,
    tier: "professional",
    role: "user",
  });

  console.log("  demo login      :", demoEmail, "/", demoPassword);
  console.log("  demo api key    :", demo.plaintext);
  console.log("");
}

if (adminPassword === adminEmail) {
  console.log("  WARNING: the admin password equals the email address.");
  console.log("           Set ADMIN_PASSWORD to something stronger before deploying.");
  console.log("");
}

console.log("  The API key is shown once. It is stored hashed.");

db.close();
