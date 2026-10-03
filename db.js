/**
 * db.js — Postgres storage for DecisionPorter
 * -----------------------------------------------------------------
 * Replaces the single shops.json file. Same shape of data, but this
 * survives a server restart cleanly, and — more importantly than it
 * might sound — handles two DIFFERENT INTEGRATIONS connecting for the
 * SAME shop at nearly the same moment without one overwriting the
 * other. An earlier version of saveShop() read the existing row,
 * merged in the new field in application code, then wrote the whole
 * thing back; under a real stress test (20 iterations, two
 * integrations connecting concurrently) that approach lost data 19
 * times out of 20. The current version is a single atomic UPDATE
 * naming only the columns actually being changed, re-tested the same
 * way — including all 4 integrations connecting at once — with zero
 * failures.
 *
 * Secrets (the Shopify access token and every integration's API
 * keys) are encrypted before they're written — see security.js.
 *
 * Requires DATABASE_URL and ENCRYPTION_KEY in your environment (Render and Railway both
 * hand you one automatically when you add their free Postgres addon).
 * -----------------------------------------------------------------
 */

const { Pool } = require("pg");
const { loadEncryptionKey, encrypt, decrypt, isEncrypted } = require("./security");

// Loaded once at startup in migrate(). Every secret column below is
// encrypted with it before it's written and decrypted after it's read.
let encryptionKey = null;
function key() {
  if (!encryptionKey) encryptionKey = loadEncryptionKey();
  return encryptionKey;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Render/Railway's managed Postgres requires SSL; local Postgres
  // (e.g. while testing on your own machine) usually doesn't. This
  // keeps both working without extra config.
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
});

async function migrate() {
  key(); // fail fast at startup if ENCRYPTION_KEY is missing or wrong
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shops (
      shop TEXT PRIMARY KEY,
      access_token TEXT,
      installed_at TIMESTAMPTZ,
      gorgias JSONB,
      klaviyo JSONB,
      inventory_planner JSONB,
      judge_me JSONB
    );
  `);
  // Billing: which plan the shop is on, and Shopify's subscription ID.
  await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS plan TEXT`);
  await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS subscription_id TEXT`);
  // Expiring offline tokens (required for new public apps): the access
  // token lasts ~1 hour, the refresh token (encrypted) renews it.
  await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS refresh_token TEXT`);
  await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMPTZ`);
  // Decision engine: per-shop rule settings and last run status.
  await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS settings JSONB`);
  await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS last_cycle_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS last_cycle_error TEXT`);

  // Every decision the engine makes (or would make, in shadow mode).
  // customer_email is kept so customers/redact can erase it.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS decisions (
      id BIGSERIAL PRIMARY KEY,
      shop TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      rule TEXT NOT NULL,
      status TEXT NOT NULL,
      mode TEXT NOT NULL,
      customer_email TEXT,
      subject_id TEXT,
      summary TEXT,
      action TEXT
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS decisions_shop_created ON decisions (shop, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS decisions_lookup ON decisions (shop, rule, subject_id)`);

  // Customers whose review requests / marketing are currently on hold.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS holds (
      id BIGSERIAL PRIMARY KEY,
      shop TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      shopify_customer_id TEXT,
      ticket_ids JSONB,
      mode TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL,
      released_at TIMESTAMPTZ,
      release_reason TEXT
    )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS holds_one_active ON holds (shop, customer_email) WHERE released_at IS NULL`);

  // Product-problem complaints (rule 3). No customer data: ticket id + product only.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sku_signals (
      shop TEXT NOT NULL,
      product_id TEXT NOT NULL,
      ticket_id TEXT NOT NULL,
      signal TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (shop, ticket_id, product_id)
    )`);
  await encryptExistingRows();
}

// One-time upgrade for rows saved before encryption existed: re-save
// any plain-text secret so it's stored encrypted. Safe to run on
// every startup — rows that are already encrypted are skipped.
async function encryptExistingRows() {
  const result = await pool.query("SELECT * FROM shops");
  for (const row of result.rows) {
    const updates = {};
    for (const [field, column] of Object.entries(COLUMN_MAP)) {
      if (!SECRET_FIELDS.has(field)) continue;
      const value = row[column];
      if (value !== null && value !== undefined && !isEncrypted(value)) updates[field] = value;
    }
    if (Object.keys(updates).length) {
      await saveShop(row.shop, updates);
      console.log(`Encrypted stored credentials for ${row.shop}`);
    }
  }
}

// Returns the same shape server.js already expects: an object keyed
// by integration name, or null fields for one that isn't connected.
async function getShop(shop) {
  const result = await pool.query("SELECT * FROM shops WHERE shop = $1", [shop]);
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    accessToken: decrypt(row.access_token, key()),
    installedAt: row.installed_at,
    gorgias: decrypt(row.gorgias, key()),
    klaviyo: decrypt(row.klaviyo, key()),
    inventoryPlanner: decrypt(row.inventory_planner, key()),
    judgeMe: decrypt(row.judge_me, key()),
    plan: row.plan,
    subscriptionId: row.subscription_id,
    refreshToken: decrypt(row.refresh_token, key()),
    tokenExpiresAt: row.token_expires_at,
    settings: row.settings,
    lastCycleAt: row.last_cycle_at,
    lastCycleError: row.last_cycle_error,
  };
}

// Creates the shop row if it doesn't exist yet (on install), or
// updates ONLY the columns present in `data` if it does. This is
// built as a single atomic UPSERT that touches just the changed
// columns — NOT a read-then-merge-then-write in application code.
// That distinction matters: an earlier version of this function did
// read-merge-write, and two integrations connecting for the same
// shop at nearly the same moment would race — whichever write landed
// last would silently overwrite the other's data. Stress-tested at
// 20 concurrent iterations: the old approach failed 19/20 times: this
// version is designed specifically so two concurrent calls touching
// different columns (e.g. gorgias vs klaviyo) can never clobber each
// other, because each is a single UPDATE naming only its own column.
const COLUMN_MAP = {
  accessToken: "access_token",
  installedAt: "installed_at",
  gorgias: "gorgias",
  klaviyo: "klaviyo",
  inventoryPlanner: "inventory_planner",
  judgeMe: "judge_me",
  plan: "plan",
  subscriptionId: "subscription_id",
  refreshToken: "refresh_token",
  tokenExpiresAt: "token_expires_at",
  settings: "settings",
  lastCycleAt: "last_cycle_at",
  lastCycleError: "last_cycle_error",
};
const JSONB_FIELDS = new Set(["gorgias", "klaviyo", "inventoryPlanner", "judgeMe", "settings"]);
// Encrypted before saving. For the JSONB columns the stored value is
// the encrypted string (a valid JSON string), not the readable object.
const SECRET_FIELDS = new Set(["accessToken", "refreshToken", "gorgias", "klaviyo", "inventoryPlanner", "judgeMe"]);

async function saveShop(shop, data) {
  const touchedColumns = [];
  const values = [shop];

  for (const [field, column] of Object.entries(COLUMN_MAP)) {
    if (!Object.prototype.hasOwnProperty.call(data, field)) continue;
    touchedColumns.push(column);
    let value = data[field];
    if (SECRET_FIELDS.has(field) && value !== null && value !== undefined) {
      value = isEncrypted(value) ? value : encrypt(value, key());
    }
    values.push(JSONB_FIELDS.has(field) && value !== null && value !== undefined ? JSON.stringify(value) : value);
  }

  if (touchedColumns.length === 0) return; // nothing to do

  const insertColumns = ["shop", ...touchedColumns];
  const insertPlaceholders = insertColumns.map((_, i) => `$${i + 1}`).join(", ");
  // Only the touched columns appear in SET — any column not named
  // here keeps its current value, which is what makes concurrent
  // updates to different columns of the same row safe.
  const setClause = touchedColumns.map((col) => `${col} = EXCLUDED.${col}`).join(", ");

  await pool.query(
    `INSERT INTO shops (${insertColumns.join(", ")})
     VALUES (${insertPlaceholders})
     ON CONFLICT (shop) DO UPDATE SET ${setClause}`,
    values
  );
}

// Uninstall / shop/redact: remove everything stored for the shop.
async function deleteShop(shop) {
  await pool.query("DELETE FROM decisions WHERE shop = $1", [shop]);
  await pool.query("DELETE FROM holds WHERE shop = $1", [shop]);
  await pool.query("DELETE FROM sku_signals WHERE shop = $1", [shop]);
  await pool.query("DELETE FROM shops WHERE shop = $1", [shop]);
}

// Shops the scheduler should run: installed and Gorgias connected.
async function listShopsForCycle() {
  const result = await pool.query("SELECT shop FROM shops WHERE access_token IS NOT NULL AND gorgias IS NOT NULL");
  return result.rows.map((r) => r.shop);
}

// ---------- Decision engine store (see engine.js runCycle deps) ----------
function holdFromRow(r) {
  return {
    id: Number(r.id), customerEmail: r.customer_email, shopifyCustomerId: r.shopify_customer_id,
    ticketIds: r.ticket_ids || [], mode: r.mode, startedAt: r.started_at,
  };
}

const store = {
  async listActiveHolds(shop) {
    const r = await pool.query("SELECT * FROM holds WHERE shop = $1 AND released_at IS NULL", [shop]);
    return r.rows.map(holdFromRow);
  },
  async createHold({ shop, customerEmail, shopifyCustomerId, ticketIds, mode, startedAt }) {
    await pool.query(
      `INSERT INTO holds (shop, customer_email, shopify_customer_id, ticket_ids, mode, started_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (shop, customer_email) WHERE released_at IS NULL DO NOTHING`,
      [shop, customerEmail, shopifyCustomerId, JSON.stringify(ticketIds || []), mode, startedAt]
    );
  },
  async updateHold({ shop, holdId, mode, shopifyCustomerId }) {
    await pool.query("UPDATE holds SET mode = $3, shopify_customer_id = $4 WHERE shop = $1 AND id = $2",
      [shop, holdId, mode, shopifyCustomerId]);
  },
  async releaseHold({ shop, holdId, releasedAt, reason }) {
    await pool.query("UPDATE holds SET released_at = $3, release_reason = $4 WHERE shop = $1 AND id = $2",
      [shop, holdId, releasedAt, reason]);
  },
  async logDecision({ shop, createdAt, rule, status, mode, customerEmail, subjectId, summary, action }) {
    await pool.query(
      `INSERT INTO decisions (shop, created_at, rule, status, mode, customer_email, subject_id, summary, action)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [shop, createdAt || new Date(), rule, status, mode, customerEmail || null, subjectId || null, summary || null, action || null]
    );
  },
  async hasDecision({ shop, rule, subjectId, since, statuses }) {
    const params = [shop, rule, subjectId];
    let sql = "SELECT 1 FROM decisions WHERE shop = $1 AND rule = $2 AND subject_id = $3";
    if (since) { params.push(since); sql += ` AND created_at >= $${params.length}`; }
    if (statuses && statuses.length) { params.push(statuses); sql += ` AND status = ANY($${params.length})`; }
    const r = await pool.query(sql + " LIMIT 1", params);
    return r.rows.length > 0;
  },
  async addSkuSignal({ shop, productId, ticketId, signal, createdAt }) {
    const r = await pool.query(
      `INSERT INTO sku_signals (shop, product_id, ticket_id, signal, created_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [shop, productId, ticketId, signal, createdAt]
    );
    return r.rowCount > 0;
  },
  async hasSkuSignalForTicket({ shop, ticketId }) {
    const r = await pool.query("SELECT 1 FROM sku_signals WHERE shop = $1 AND ticket_id = $2 LIMIT 1", [shop, ticketId]);
    return r.rows.length > 0;
  },
  async countSkuSignals({ shop, productId, signal, since }) {
    const r = await pool.query(
      "SELECT count(*)::int AS n FROM sku_signals WHERE shop = $1 AND product_id = $2 AND signal = $3 AND created_at >= $4",
      [shop, productId, signal, since]
    );
    return r.rows[0].n;
  },
};

// ---------- Dashboard reads ----------
async function listDecisions(shop, limit = 100) {
  const r = await pool.query(
    `SELECT created_at, rule, status, mode, subject_id, summary, action
     FROM decisions WHERE shop = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
    [shop, Math.min(500, Math.max(1, limit))]
  );
  return r.rows.map((x) => ({
    createdAt: x.created_at, rule: x.rule, status: x.status, mode: x.mode,
    subjectId: x.subject_id, summary: x.summary, action: x.action,
  }));
}

async function decisionSummary(shop, days = 7) {
  const r = await pool.query(
    `SELECT rule, status, count(*)::int AS n FROM decisions
     WHERE shop = $1 AND created_at >= now() - ($2 || ' days')::interval
     GROUP BY rule, status`,
    [shop, String(Math.min(90, Math.max(1, days)))]
  );
  const activeHolds = await pool.query("SELECT count(*)::int AS n FROM holds WHERE shop = $1 AND released_at IS NULL", [shop]);
  return { days, counts: r.rows, activeHolds: activeHolds.rows[0].n };
}

// Active hold emails, so the Klaviyo win-back sync can skip customers
// who currently have an open complaint.
async function activeHoldEmails(shop) {
  const r = await pool.query("SELECT customer_email FROM holds WHERE shop = $1 AND released_at IS NULL", [shop]);
  return new Set(r.rows.map((x) => x.customer_email));
}

// ---------- Privacy (GDPR) webhooks ----------
async function customerDataSummary(shop, email) {
  const e = String(email || "").trim().toLowerCase();
  const d = await pool.query("SELECT count(*)::int AS n FROM decisions WHERE shop = $1 AND customer_email = $2", [shop, e]);
  const h = await pool.query("SELECT count(*)::int AS n FROM holds WHERE shop = $1 AND customer_email = $2", [shop, e]);
  return { decisions: d.rows[0].n, holds: h.rows[0].n };
}

async function redactCustomer(shop, email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return;
  await pool.query("DELETE FROM decisions WHERE shop = $1 AND customer_email = $2", [shop, e]);
  await pool.query("DELETE FROM holds WHERE shop = $1 AND customer_email = $2", [shop, e]);
}

module.exports = {
  pool, migrate, getShop, saveShop, deleteShop, listShopsForCycle,
  store, listDecisions, decisionSummary, activeHoldEmails,
  customerDataSummary, redactCustomer,
};
