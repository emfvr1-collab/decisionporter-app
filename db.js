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
};
const JSONB_FIELDS = new Set(["gorgias", "klaviyo", "inventoryPlanner", "judgeMe"]);
// Encrypted before saving. For the JSONB columns the stored value is
// the encrypted string (a valid JSON string), not the readable object.
const SECRET_FIELDS = new Set(["accessToken", "gorgias", "klaviyo", "inventoryPlanner", "judgeMe"]);

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

async function deleteShop(shop) {
  await pool.query("DELETE FROM shops WHERE shop = $1", [shop]);
}

module.exports = { pool, migrate, getShop, saveShop, deleteShop };
