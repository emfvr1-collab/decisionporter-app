/**
 * security.js — session tokens and encryption for DecisionPorter
 * -----------------------------------------------------------------
 * Two jobs:
 *
 * 1. SESSION TOKENS. Every /api request from the embedded dashboard
 *    carries a short-lived token that Shopify App Bridge signs with
 *    your app's API secret. We verify that signature and read the
 *    shop from the TOKEN — never from ?shop= or the request body,
 *    which anyone can type. Without this, anyone who knew a store's
 *    .myshopify.com address could run its syncs or replace its keys.
 *
 * 2. ENCRYPTION AT REST. Third-party API keys (Gorgias, Klaviyo,
 *    Inventory Planner, Judge.me) and the Shopify access token are
 *    encrypted with AES-256-GCM before they reach Postgres, using
 *    ENCRYPTION_KEY from your environment. A leaked database backup
 *    is then useless without that key.
 *
 * No extra npm packages — only Node's built-in crypto.
 * -----------------------------------------------------------------
 */

const crypto = require("crypto");

// Shop domains must look like "your-store.myshopify.com". Checked
// before we ever build a URL or redirect with one.
const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

function isValidShopDomain(shop) {
  return typeof shop === "string" && SHOP_DOMAIN_RE.test(shop);
}

// ---------- Session tokens ----------

function base64UrlDecode(str) {
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/**
 * Verifies a Shopify session token (a HS256 JWT) and returns the shop
 * domain it was issued for. Throws if anything about it is wrong.
 */
function verifySessionToken(token, { apiKey, apiSecret, clockSkewSeconds = 10, now = Date.now() } = {}) {
  if (!apiKey || !apiSecret) throw new Error("Server is missing SHOPIFY_API_KEY or SHOPIFY_API_SECRET");
  if (typeof token !== "string") throw new Error("Missing session token");

  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed session token");
  const [headerB64, payloadB64, signatureB64] = parts;

  let header, payload;
  try {
    header = JSON.parse(base64UrlDecode(headerB64).toString("utf8"));
    payload = JSON.parse(base64UrlDecode(payloadB64).toString("utf8"));
  } catch {
    throw new Error("Malformed session token");
  }
  if (header.alg !== "HS256") throw new Error("Unexpected session token algorithm");

  const expected = crypto.createHmac("sha256", apiSecret).update(`${headerB64}.${payloadB64}`).digest();
  const given = base64UrlDecode(signatureB64);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    throw new Error("Invalid session token signature");
  }

  const nowSec = Math.floor(now / 1000);
  if (typeof payload.exp !== "number" || nowSec > payload.exp + clockSkewSeconds) throw new Error("Session token expired");
  if (typeof payload.nbf === "number" && nowSec < payload.nbf - clockSkewSeconds) throw new Error("Session token not yet valid");

  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(apiKey)) throw new Error("Session token was issued for a different app");

  let shop;
  try {
    shop = new URL(payload.dest).hostname;
  } catch {
    throw new Error("Session token has no valid shop");
  }
  if (!isValidShopDomain(shop)) throw new Error("Session token has no valid shop");

  // iss is "https://{shop}/admin" — it must name the same shop as dest.
  if (payload.iss) {
    let issHost;
    try { issHost = new URL(payload.iss).hostname; } catch { issHost = null; }
    if (issHost !== shop) throw new Error("Session token shop mismatch");
  }

  return { shop, payload };
}

/**
 * Express middleware: requires a valid session token and sets
 * req.shop from it. Any "shop" sent in the query or body is ignored.
 */
function requireSessionToken({ apiKey, apiSecret }) {
  return (req, res, next) => {
    const auth = req.get("Authorization") || "";
    const match = auth.match(/^Bearer (.+)$/);
    if (!match) return res.status(401).json({ ok: false, error: "Not signed in — open DecisionPorter from your Shopify admin." });
    try {
      const { shop, payload } = verifySessionToken(match[1], { apiKey, apiSecret });
      req.shop = shop;
      // Shopify staff member's user id ("sub"), used for the access log.
      req.shopUser = payload.sub ? String(payload.sub) : null;
      next();
    } catch (err) {
      // Header tells App Bridge to fetch a fresh token and retry.
      res.set("X-Shopify-Retry-Invalid-Session-Request", "1");
      res.status(401).json({ ok: false, error: "Your session expired — reload the app from your Shopify admin." });
    }
  };
}

// ---------- Encryption at rest ----------

const ENC_PREFIX = "enc:v1:";

function loadEncryptionKey(raw = process.env.ENCRYPTION_KEY) {
  if (!raw) {
    throw new Error(
      "ENCRYPTION_KEY is not set. Generate one with:\n" +
      "  node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"\n" +
      "and add it to your environment (Render: Environment tab). Keep it secret and never change it " +
      "once real stores have connected, or their saved keys can't be read."
    );
  }
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes (64 hex characters or 44 base64 characters)");
  return key;
}

function isEncrypted(value) {
  return typeof value === "string" && value.startsWith(ENC_PREFIX);
}

// Encrypts any JSON-serializable value into a single string.
function encrypt(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + [iv, tag, ciphertext].map((b) => b.toString("base64")).join(":");
}

// Reverses encrypt(). Values saved before encryption existed (plain
// text or plain JSON) are returned unchanged, so old rows keep working
// until they're re-saved encrypted.
function decrypt(value, key) {
  if (!isEncrypted(value)) return value;
  const [ivB64, tagB64, dataB64] = value.slice(ENC_PREFIX.length).split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}

module.exports = {
  isValidShopDomain,
  verifySessionToken,
  requireSessionToken,
  loadEncryptionKey,
  isEncrypted,
  encrypt,
  decrypt,
};
