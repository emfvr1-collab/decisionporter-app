/**
 * DECISIONPORTER — Shopify Starter App
 * -----------------------------------------------------------------
 * This is a REAL, working Shopify app skeleton — not a mockup.
 * It handles:
 *   1. Installing the app on a store (OAuth)
 *   2. The 4 webhooks Shopify REQUIRES before it will review any app
 *   3. A basic recurring billing charge (your pricing tiers)
 *   4. A real embedded dashboard with 4 working integrations
 *      (Gorgias, Klaviyo, Inventory Planner, Judge.me)
 *   5. Persistent storage in Postgres (see db.js) — this used to be
 *      a single JSON file; swapped out once real concurrent
 *      merchants became a real possibility, not just a hypothetical.
 *
 * Read README.md for the plain-English setup steps.
 * -----------------------------------------------------------------
 */

require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const fetch = require("node-fetch");
const path = require("path");
const db = require("./db");
const { requireSessionToken, isValidShopDomain } = require("./security");
const engine = require("./engine");
const { classifyTicket } = engine;
const clients = require("./clients");

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Config from your .env file (see .env.example) ----
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const APP_URL = process.env.APP_URL; // e.g. https://your-app.onrender.com
// read_orders: match complaints to the product in the customer's last order (rule 3)
// write_products: tag products with sizing/quality complaints (rule 3)
// write_customers: look up lifetime spend (rule 4) and tag customers whose
//   review requests are on hold (rule 1). Customer data is "protected
//   customer data": request access in the Partner Dashboard before review.
const SCOPES = "read_orders,write_products,write_customers";
// Shopify retires each Admin API version about a year after release,
// so keep this current (check shopify.dev/docs/api/usage/versioning).
const API_VERSION = "2026-07";

// Parse JSON for everything EXCEPT /webhooks. Webhook routes need the
// raw, unparsed body to check Shopify's signature; if this global
// parser ran first, the raw body was gone and every webhook failed
// verification — including the privacy webhooks Shopify tests during
// app review.
const parseJson = express.json();
app.use((req, res, next) => (req.path.startsWith("/webhooks") ? next() : parseJson(req, res, next)));
app.use("/public", express.static(path.join(__dirname, "public")));

// Small cookie reader (avoids adding a dependency for one cookie).
function readCookie(req, name) {
  const header = req.get("Cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

// -------------------------------------------------------------
// STEP 1: Start install — Shopify sends the merchant here first
// -------------------------------------------------------------
app.get("/auth", (req, res) => {
  const shop = req.query.shop;
  if (!isValidShopDomain(shop)) return res.status(400).send("Missing or invalid ?shop= parameter (expected your-store.myshopify.com)");

  // Random value remembered in a short-lived cookie and checked on the
  // way back, so nobody can trick a merchant into completing an
  // install they didn't start.
  const state = crypto.randomBytes(16).toString("hex");
  res.setHeader(
    "Set-Cookie",
    `dp_oauth_state=${state}; Max-Age=600; Path=/auth; HttpOnly; Secure; SameSite=Lax`
  );
  const redirectUri = `${APP_URL}/auth/callback`;

  const installUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${SHOPIFY_API_KEY}` +
    `&scope=${SCOPES}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${state}`;

  res.redirect(installUrl);
});

// -------------------------------------------------------------
// STEP 2: Shopify redirects back here after the merchant approves
// -------------------------------------------------------------
app.get("/auth/callback", async (req, res) => {
  const { shop, code, hmac, state } = req.query;
  if (!shop || !code || !hmac) return res.status(400).send("Missing required parameters");
  if (!isValidShopDomain(shop)) return res.status(400).send("Invalid shop domain");
  const expectedState = readCookie(req, "dp_oauth_state");
  if (!state || !expectedState || state !== expectedState) {
    return res.status(403).send("Install session expired or didn't match — please start the install again.");
  }

  // Verify the request really came from Shopify before trusting it
  const params = { ...req.query };
  delete params.hmac;
  delete params.signature;
  const message = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
  const generatedHash = crypto
    .createHmac("sha256", SHOPIFY_API_SECRET)
    .update(message)
    .digest("hex");

  const hmacOk =
    typeof hmac === "string" &&
    hmac.length === generatedHash.length &&
    crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(generatedHash));
  if (!hmacOk) {
    return res.status(400).send("HMAC validation failed — request did not come from Shopify");
  }

  try {
    // Exchange the temporary code for a permanent access token
    const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: SHOPIFY_API_KEY,
        client_secret: SHOPIFY_API_SECRET,
        code,
        expiring: "1", // request a modern expiring offline token (Shopify requirement as of 2026)
      }),
    });
    const tokenData = await tokenResponse.json();

    if (!tokenData.access_token) {
      return res.status(500).send("Could not get an access token from Shopify");
    }

    // Save the shop + token. Expiring offline tokens last ~1 hour; the
    // refresh token renews them (see clients.js makeTokenManager).
    await db.saveShop(shop, {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || null,
      tokenExpiresAt: tokenData.expires_in ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString() : null,
      installedAt: new Date().toISOString(),
    });

    // Register the webhooks Shopify requires
    await registerMandatoryWebhooks(shop, tokenData.access_token);
  } catch (err) {
    console.error("Install failed:", err.message);
    return res.status(502).send("Could not reach Shopify to finish installing — please try again.");
  }

  // Send the merchant into the app inside their Shopify admin, where
  // App Bridge can issue session tokens for the dashboard.
  res.setHeader("Set-Cookie", "dp_oauth_state=; Max-Age=0; Path=/auth; HttpOnly; Secure; SameSite=Lax");
  res.redirect(`https://${shop}/admin/apps/${SHOPIFY_API_KEY}`);
});

async function registerMandatoryWebhooks(shop, accessToken) {
  const topics = [
    { topic: "app/uninstalled", address: `${APP_URL}/webhooks/app/uninstalled` },
    { topic: "customers/data_request", address: `${APP_URL}/webhooks/customers/data_request` },
    { topic: "customers/redact", address: `${APP_URL}/webhooks/customers/redact` },
    { topic: "shop/redact", address: `${APP_URL}/webhooks/shop/redact` },
  ];

  for (const hook of topics) {
    try {
      await fetch(`https://${shop}/admin/api/${API_VERSION}/webhooks.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          webhook: { topic: hook.topic, address: hook.address, format: "json" },
        }),
      });
    } catch (err) {
      console.error(`Failed to register webhook ${hook.topic}:`, err.message);
    }
  }
}

// -------------------------------------------------------------
// Helper: verify a webhook actually came from Shopify
// -------------------------------------------------------------
function verifyWebhookHmac(req) {
  // If SHOPIFY_API_SECRET is missing or misconfigured, fail closed
  // (treat as unverified) instead of letting crypto throw and
  // crashing the request with a stack trace in the response.
  if (!SHOPIFY_API_SECRET) {
    console.error("verifyWebhookHmac: SHOPIFY_API_SECRET is not set — rejecting webhook");
    return false;
  }
  try {
    const hmacHeader = req.get("X-Shopify-Hmac-Sha256") || "";
    const generatedHash = crypto
      .createHmac("sha256", SHOPIFY_API_SECRET)
      .update(req.rawBody || "", "utf8")
      .digest("base64");
    return (
      hmacHeader.length === generatedHash.length &&
      crypto.timingSafeEqual(Buffer.from(hmacHeader), Buffer.from(generatedHash))
    );
  } catch (err) {
    console.error("verifyWebhookHmac failed:", err.message);
    return false;
  }
}

// Capture the raw body for HMAC verification on webhook routes
app.use("/webhooks", express.json({
  verify: (req, res, buf) => { req.rawBody = buf.toString("utf8"); },
}));

// -------------------------------------------------------------
// REQUIRED webhook #1: app uninstalled — clean up the shop's data
// -------------------------------------------------------------
app.post("/webhooks/app/uninstalled", async (req, res) => {
  if (!verifyWebhookHmac(req)) return res.sendStatus(401);
  const shop = req.get("X-Shopify-Shop-Domain");
  try {
    await db.deleteShop(shop);
    res.sendStatus(200);
  } catch (err) {
    console.error("Failed to delete shop on uninstall:", err.message);
    res.sendStatus(500);
  }
});

// -------------------------------------------------------------
// REQUIRED webhook #2: a customer asks what data you hold on them
// -------------------------------------------------------------
app.post("/webhooks/customers/data_request", async (req, res) => {
  if (!verifyWebhookHmac(req)) return res.sendStatus(401);
  // DecisionPorter stores a customer's email only in the decision log
  // and hold records. Log what we hold so the merchant can be sent it.
  const shop = req.body && req.body.shop_domain;
  const email = req.body && req.body.customer && req.body.customer.email;
  try {
    const held = email ? await db.customerDataSummary(shop, email) : { decisions: 0, holds: 0 };
    if (shop) await db.logAccess({ shop, actor: "shopify-webhook", action: "customers/data_request" });
    console.log(`Customer data request for ${shop}: ${held.decisions} decision rows, ${held.holds} hold rows (request id ${req.body.data_request && req.body.data_request.id})`);
    res.sendStatus(200);
  } catch (err) {
    console.error("customers/data_request failed:", err.message);
    res.sendStatus(500);
  }
});

// -------------------------------------------------------------
// REQUIRED webhook #3: erase a specific customer's data
// -------------------------------------------------------------
app.post("/webhooks/customers/redact", async (req, res) => {
  if (!verifyWebhookHmac(req)) return res.sendStatus(401);
  // Erase every decision and hold that names this customer.
  const shop = req.body && req.body.shop_domain;
  const email = req.body && req.body.customer && req.body.customer.email;
  try {
    if (shop && email) {
      await db.redactCustomer(shop, email);
      await db.logAccess({ shop, actor: "shopify-webhook", action: "customers/redact" });
    }
    res.sendStatus(200);
  } catch (err) {
    console.error("customers/redact failed:", err.message);
    res.sendStatus(500);
  }
});

// -------------------------------------------------------------
// REQUIRED webhook #4: erase all of a shop's data (after uninstall)
// -------------------------------------------------------------
app.post("/webhooks/shop/redact", async (req, res) => {
  if (!verifyWebhookHmac(req)) return res.sendStatus(401);
  const shop = req.body.shop_domain;
  try {
    await db.deleteShop(shop);
    res.sendStatus(200);
  } catch (err) {
    console.error("Failed to delete shop on shop/redact:", err.message);
    res.sendStatus(500);
  }
});

// -------------------------------------------------------------
// BILLING: recurring subscription for one of your 3 plans
// -------------------------------------------------------------
// Uses Shopify's GraphQL Billing API (appSubscriptionCreate). Flow:
//   1. Dashboard calls POST /api/billing/subscribe (signed in).
//   2. We ask Shopify for a subscription and get a confirmation URL.
//   3. The dashboard sends the merchant's whole browser tab there.
//   4. After they approve, Shopify sends them to /billing/callback,
//      where we ask Shopify which subscription is ACTUALLY active and
//      save that plan — we never trust the URL alone.
const PLANS = {
  starter: { name: "Starter", price: 29.0 },
  growth: { name: "Growth", price: 79.0 },
  scale: { name: "Scale", price: 199.0 },
};
const TRIAL_DAYS = 14;

// Turns a Shopify subscription name back into our plan key.
function planKeyFromSubscriptionName(name) {
  const entry = Object.entries(PLANS).find(([, p]) => `DecisionPorter — ${p.name}` === name);
  return entry ? entry[0] : null;
}

// Always get the Shopify token through this — it refreshes expiring
// offline tokens before they lapse.
const getShopifyToken = clients.makeTokenManager({ db, fetch, apiKey: SHOPIFY_API_KEY, apiSecret: SHOPIFY_API_SECRET });

async function shopifyGraphql(shop, accessToken, query, variables) {
  const response = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`Shopify returned ${response.status}`);
  const data = await response.json();
  if (data.errors) throw new Error(data.errors.map((e) => e.message).join("; "));
  return data.data;
}

async function fetchActiveSubscription(shop, accessToken) {
  const data = await shopifyGraphql(
    shop,
    accessToken,
    `query { currentAppInstallation { activeSubscriptions { id name status trialDays } } }`
  );
  const subs = (data.currentAppInstallation && data.currentAppInstallation.activeSubscriptions) || [];
  return subs.find((s) => s.status === "ACTIVE") || null;
}

// Every /api route below this line requires a valid session token and
// uses the shop FROM THE TOKEN (req.shop), never from the request.
app.use("/api", requireSessionToken({ apiKey: SHOPIFY_API_KEY, apiSecret: SHOPIFY_API_SECRET }));

// Access log: every dashboard request that returns or changes data that
// can include customer personal data is recorded with the Shopify staff
// user who made it. Status checks are skipped (no personal data).
const LOGGED_API = /^\/api\/(decisions|summary|run|settings|access-log|[a-z-]+\/sync)$/;
app.use("/api", (req, res, next) => {
  const p = req.baseUrl + req.path;
  if (LOGGED_API.test(p) && !(p === "/api/settings" && req.method === "GET")) {
    db.logAccess({ shop: req.shop, actor: `shopify-user:${req.shopUser || "unknown"}`, action: `${req.method} ${p}` })
      .catch((err) => console.error("Access log write failed:", err.message));
  }
  next();
});

app.get("/api/billing/status", async (req, res) => {
  const shopData = await db.getShop(req.shop);
  res.json({ ok: true, plan: (shopData && shopData.plan) || null });
});

app.post("/api/billing/subscribe", async (req, res) => {
  const shop = req.shop;
  const planKey = req.body && req.body.plan;
  const plan = PLANS[planKey];
  if (!plan) return res.status(400).json({ ok: false, error: "Unknown plan" });

  const shopData = await db.getShop(shop);
  if (!shopData || !shopData.accessToken) return res.status(401).json({ ok: false, error: "Install the app on this store first" });

  try {
    const data = await shopifyGraphql(
      shop,
      await getShopifyToken(shop),
      `mutation Subscribe($name: String!, $returnUrl: URL!, $trialDays: Int, $test: Boolean, $lineItems: [AppSubscriptionLineItemInput!]!) {
        appSubscriptionCreate(name: $name, returnUrl: $returnUrl, trialDays: $trialDays, test: $test, lineItems: $lineItems) {
          confirmationUrl
          userErrors { field message }
        }
      }`,
      {
        name: `DecisionPorter — ${plan.name}`,
        returnUrl: `${APP_URL}/billing/callback?shop=${encodeURIComponent(shop)}`,
        trialDays: TRIAL_DAYS,
        test: process.env.BILLING_TEST_MODE === "true", // keep true until you launch for real
        lineItems: [
          {
            plan: {
              appRecurringPricingDetails: {
                price: { amount: plan.price, currencyCode: "USD" },
                interval: "EVERY_30_DAYS",
              },
            },
          },
        ],
      }
    );
    const result = data.appSubscriptionCreate;
    if (result.userErrors && result.userErrors.length) {
      return res.status(400).json({ ok: false, error: result.userErrors.map((e) => e.message).join("; ") });
    }
    res.json({ ok: true, confirmationUrl: result.confirmationUrl });
  } catch (err) {
    console.error("Billing subscription failed:", err.message);
    res.status(502).json({ ok: false, error: "Could not reach Shopify to set up billing — please try again." });
  }
});

// Shopify sends the merchant here (top-level, no session token) after
// they approve or decline the charge. The ?shop= value is only used to
// look up which store to ask; the plan we save comes from Shopify.
app.get("/billing/callback", async (req, res) => {
  const shop = req.query.shop;
  if (!isValidShopDomain(shop)) return res.status(400).send("Invalid shop");

  const shopData = await db.getShop(shop);
  if (!shopData || !shopData.accessToken) return res.status(401).send("Shop not installed");

  try {
    const active = await fetchActiveSubscription(shop, await getShopifyToken(shop));
    const planKey = active ? planKeyFromSubscriptionName(active.name) : null;
    await db.saveShop(shop, { plan: planKey, subscriptionId: active ? active.id : null });
  } catch (err) {
    console.error("Could not confirm subscription:", err.message);
  }
  res.redirect(`https://${shop}/admin/apps/${SHOPIFY_API_KEY}`);
});

// -------------------------------------------------------------
// GORGIAS INTEGRATION
// -------------------------------------------------------------
// Verified against developers.gorgias.com on 2026-09-16:
//   - Auth: HTTP Basic, base64("your-email:your-api-key")
//   - Base URL: https://{subdomain}.gorgias.com/api
//   - GET /account            -> used here to validate credentials
//   - GET /tickets             -> NOTE: this endpoint has no "status"
//     query filter. You get back a page of tickets and filter by
//     ticket.status yourself (that's what filterOpenTickets does).
//   - ticket.summary.content   -> Gorgias's own AI-generated summary
//     of the conversation. We use this (plus the subject line) to
//     classify, so we don't need a second API call per ticket to
//     fetch full message bodies.
//   - POST /tickets/{id}/tags  -> body { names: ["tag-name"] }, 201
//     with no response content on success.

function gorgiasAuthHeader(email, apiKey) {
  const token = Buffer.from(`${email}:${apiKey}`).toString("base64");
  return `Basic ${token}`;
}

async function verifyGorgiasCredentials(subdomain, email, apiKey) {
  const res = await fetch(`https://${subdomain}.gorgias.com/api/account`, {
    headers: { Authorization: gorgiasAuthHeader(email, apiKey) },
  });
  return res.ok;
}

async function fetchOpenGorgiasTickets(subdomain, email, apiKey) {
  const res = await fetch(
    `https://${subdomain}.gorgias.com/api/tickets?limit=30&order_by=updated_datetime:desc`,
    { headers: { Authorization: gorgiasAuthHeader(email, apiKey) } }
  );
  if (!res.ok) throw new Error(`Gorgias returned ${res.status}`);
  const data = await res.json();
  const tickets = data.data || data; // API wraps results in { data: [...] } per pagination docs
  // No status filter exists on this endpoint — filter client-side.
  return tickets.filter((t) => t.status === "open" && !t.spam);
}

async function addGorgiasTag(subdomain, email, apiKey, ticketId, tagName) {
  await fetch(`https://${subdomain}.gorgias.com/api/tickets/${ticketId}/tags`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: gorgiasAuthHeader(email, apiKey),
    },
    body: JSON.stringify({ names: [tagName] }),
  });
}

// The ticket classifier now lives in engine.js (classifyTicket).

// -------------------------------------------------------------
// -------------------------------------------------------------
// KLAVIYO INTEGRATION
// -------------------------------------------------------------
// Verified against developers.klaviyo.com on 2026-09-16:
//   - Auth: header "Authorization: Klaviyo-API-Key <private-key>"
//   - Every request also needs a "revision" header (date-versioned API)
//   - Base URL: https://a.klaviyo.com/api
//   - GET /accounts                          -> used here to validate
//     credentials (returns the account tied to the key)
//   - GET /profiles?additional-fields[profile]=predictive_analytics
//     -> returns profiles WITH Klaviyo's own churn_probability
//     (0–1, computed by Klaviyo's ML model from real order history —
//     this is real predictive data, not a heuristic we're inventing)
//   - POST /lists/{id}/relationships/profiles, body
//     { data: [{ type: "profile", id: "<profile_id>" }] }
//     -> adds a profile to a list (e.g. a win-back segment), 204 on
//     success
//
// Note: churn_probability is only present once a profile has enough
// order history (Klaviyo's own minimum: roughly 3+ orders and some
// months of history) — profiles without it are simply skipped here,
// not treated as low-risk.

const KLAVIYO_REVISION = "2026-04-15";

function klaviyoHeaders(apiKey, extra = {}) {
  return {
    Authorization: `Klaviyo-API-Key ${apiKey}`,
    revision: KLAVIYO_REVISION,
    accept: "application/json",
    ...extra,
  };
}

async function verifyKlaviyoCredentials(apiKey) {
  const res = await fetch("https://a.klaviyo.com/api/accounts", {
    headers: klaviyoHeaders(apiKey),
  });
  return res.ok;
}

async function fetchProfilesWithChurnRisk(apiKey) {
  const res = await fetch(
    "https://a.klaviyo.com/api/profiles?additional-fields[profile]=predictive_analytics&page[size]=50",
    { headers: klaviyoHeaders(apiKey) }
  );
  if (!res.ok) throw new Error(`Klaviyo returned ${res.status}`);
  const data = await res.json();
  return data.data || [];
}

async function addProfileToList(apiKey, listId, profileId) {
  await fetch(`https://a.klaviyo.com/api/lists/${listId}/relationships/profiles`, {
    method: "POST",
    headers: klaviyoHeaders(apiKey, { "content-type": "application/json" }),
    body: JSON.stringify({ data: [{ type: "profile", id: profileId }] }),
  });
}

// The decision itself. Unlike the Gorgias classifier (which we had to
// build from scratch with keywords), Klaviyo already computes a real
// churn probability from actual order history — the "decision" here
// is just applying a threshold and routing the action, which is
// exactly the System One pattern this whole app is built around.
const CHURN_THRESHOLD = 0.7;

function evaluateChurnRisk(profile) {
  const pa = profile.attributes && profile.attributes.predictive_analytics;
  if (!pa || typeof pa.churn_probability !== "number") {
    return { hasData: false };
  }
  return {
    hasData: true,
    churnProbability: pa.churn_probability,
    atRisk: pa.churn_probability >= CHURN_THRESHOLD,
  };
}

// -------------------------------------------------------------
// -------------------------------------------------------------
// INVENTORY PLANNER INTEGRATION
// -------------------------------------------------------------
// Verified against help.inventory-planner.com on 2026-09-16:
//   - Auth: two headers, "Authorization: <api_key>" and
//     "Account: <account_id>" (no Bearer/Basic prefix — the raw
//     values go directly in the headers)
//   - Base URL: https://app.inventory-planner.com/
//   - GET /api/v1/variants?fields=... -> real computed metrics per
//     SKU, including:
//       - oos: forecasted number of days until this SKU sells out
//       - replenishment: the reorder quantity Inventory Planner
//         itself is already recommending
//   - IMPORTANT, confirmed directly in their docs: "data for
//     products and variants cannot be pushed into Inventory Planner
//     using the API" — there is no tag or list-style write-back
//     available here, unlike Gorgias or Klaviyo. This integration is
//     genuinely read + surface only, which actually matches the
//     original spec ("surface in an act-today dashboard view," not
//     "write back to Inventory Planner").

function inventoryPlannerHeaders(apiKey, accountId) {
  return { Authorization: apiKey, Account: accountId, accept: "application/json" };
}

async function verifyInventoryPlannerCredentials(apiKey, accountId) {
  const res = await fetch(
    "https://app.inventory-planner.com/api/v1/variants?limit=1",
    { headers: inventoryPlannerHeaders(apiKey, accountId) }
  );
  return res.ok;
}

async function fetchUrgentVariants(apiKey, accountId) {
  // Only variants Inventory Planner already recommends reordering
  // (replenishment > 0), soonest-to-stock-out first.
  const url =
    "https://app.inventory-planner.com/api/v1/variants" +
    "?fields=id,sku,title,replenishment,oos" +
    "&replenishment_gt=0&oos_sort=asc&limit=30";
  const res = await fetch(url, { headers: inventoryPlannerHeaders(apiKey, accountId) });
  if (!res.ok) throw new Error(`Inventory Planner returned ${res.status}`);
  const data = await res.json();
  return data.variants || [];
}

// The decision itself. Like the Klaviyo churn score, "oos" (days
// until stockout) is Inventory Planner's own forecast, not something
// we're guessing — DecisionPorter's job is just turning that real number into
// an urgency score and an act-today / monitor split.
const ACT_TODAY_DAYS = 7;
const MONITOR_WINDOW_DAYS = 30;

function evaluateReorderUrgency(variant) {
  if (typeof variant.oos !== "number") {
    return { hasData: false };
  }
  const urgency = Math.max(0, Math.min(1, 1 - variant.oos / MONITOR_WINDOW_DAYS));
  return {
    hasData: true,
    oosDays: variant.oos,
    urgency: Number(urgency.toFixed(2)),
    actToday: variant.oos <= ACT_TODAY_DAYS,
  };
}

// -------------------------------------------------------------
// -------------------------------------------------------------
// JUDGE.ME INTEGRATION
// -------------------------------------------------------------
// Verified against judge.me/help on 2026-09-16:
//   - Auth: shop_domain + api_token as query parameters (not headers)
//   - GET reviews:  https://api.judge.me/api/v1/reviews   (note the
//     "api." subdomain — their own docs use a different host for GET
//     than for POST, so this is intentional, not a typo)
//   - POST create:  https://judge.me/api/v1/reviews        (no "api."
//     subdomain here)
//   - IMPORTANT: their public docs only document GET (retrieve) and
//     POST (create) for reviews — there is no documented endpoint to
//     publish/hide a review or post a reply using the simple
//     shop_domain + api_token auth this integration uses. (A reply
//     capability appears to exist only behind Judge.me's separate
//     OAuth app flow, which is a materially bigger scope than the
//     other three integrations.) So like Inventory Planner, this is
//     real read + classify + surface, not a fabricated write-back.
//
// Note on field names: Judge.me's help docs don't show a full sample
// review object, so the reviewer name is read defensively below
// (falls back gracefully if the field name differs) — worth
// double-checking against a real response once you're connected.

async function verifyJudgeMeCredentials(shopDomain, apiToken) {
  const url = `https://api.judge.me/api/v1/reviews?shop_domain=${encodeURIComponent(shopDomain)}&api_token=${encodeURIComponent(apiToken)}&per_page=1`;
  const res = await fetch(url);
  return res.ok;
}

async function fetchRecentReviews(shopDomain, apiToken) {
  const url = `https://api.judge.me/api/v1/reviews?shop_domain=${encodeURIComponent(shopDomain)}&api_token=${encodeURIComponent(apiToken)}&per_page=30`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Judge.me returned ${res.status}`);
  const data = await res.json();
  return data.reviews || [];
}

// The decision itself. Rating and "has published photos" are real
// fields Judge.me returns, not guesses. Only the short-text spam
// flag below is a heuristic (like the Gorgias classifier) and is
// deliberately kept low-confidence rather than treated as certain.
function evaluateReview(review) {
  if (typeof review.rating !== "number") return { hasData: false };

  const body = (review.body || "").trim();
  const hasPhotos = !!review.has_published_pictures;

  if (review.rating <= 2) {
    return { hasData: true, category: "needs_reply", confidence: 0.9, reason: `rating ${review.rating}/5` };
  }
  if (hasPhotos) {
    return { hasData: true, category: "feature_candidate", confidence: 0.85, reason: "has published photos" };
  }
  if (body.length > 0 && body.length < 10) {
    return { hasData: true, category: "needs_spam_check", confidence: 0.5, reason: "very short review text" };
  }
  return { hasData: true, category: "routine", confidence: 0.7, reason: `rating ${review.rating}/5, no flags` };
}

function judgeMeAction(evalResult) {
  switch (evalResult.category) {
    case "needs_reply": return "Flagged: needs founder reply";
    case "feature_candidate": return "Flagged: feature on-site (has photos)";
    case "needs_spam_check": return "Flagged: check for spam (short text)";
    default: return "No action needed";
  }
}

// -------------------------------------------------------------
// Judge.me routes: connect, check status, and run a sync
// -------------------------------------------------------------
app.get("/api/judgeme/status", async (req, res) => {
  const shop = req.shop;
  const shopData = await db.getShop(shop);
  const connected = !!(shopData && shopData.judgeMe);
  res.json({ connected });
});

app.post("/api/judgeme/connect", async (req, res) => {
  const shop = req.shop;
  const { shopDomain, apiToken } = req.body;
  if (!shopDomain || !apiToken) {
    return res.status(400).json({ ok: false, error: "Missing shopDomain or apiToken" });
  }

  const valid = await verifyJudgeMeCredentials(shopDomain, apiToken);
  if (!valid) {
    return res.status(401).json({ ok: false, error: "Judge.me rejected those credentials — double-check your shop domain and Private API Token under Settings → Integrations → View API tokens." });
  }

  const shopData = await db.getShop(shop);
  if (!shopData) return res.status(401).json({ ok: false, error: "Install the app on this store first" });
  await db.saveShop(shop, { judgeMe: { shopDomain, apiToken } });
  res.json({ ok: true });
});

app.post("/api/judgeme/sync", async (req, res) => {
  const shop = req.shop;
  const shopData = await db.getShop(shop);
  const config = shopData && shopData.judgeMe;
  if (!config) return res.status(400).json({ ok: false, error: "Judge.me isn't connected for this shop yet" });

  try {
    const reviews = await fetchRecentReviews(config.shopDomain, config.apiToken);
    const results = [];

    for (const review of reviews) {
      const evalResult = evaluateReview(review);
      if (!evalResult.hasData) continue;

      const reviewerName =
        (review.reviewer && review.reviewer.name) || review.reviewer_name || "anonymous";

      results.push({
        source: "Judge.me",
        item: `Review #${review.id} — ${review.rating}★ by ${reviewerName}`,
        confidence: evalResult.confidence,
        action: judgeMeAction(evalResult),
      });
    }

    res.json({ ok: true, count: results.length, results });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// -------------------------------------------------------------
app.get("/api/inventory-planner/status", async (req, res) => {
  const shop = req.shop;
  const shopData = await db.getShop(shop);
  const connected = !!(shopData && shopData.inventoryPlanner);
  res.json({ connected });
});

app.post("/api/inventory-planner/connect", async (req, res) => {
  const shop = req.shop;
  const { apiKey, accountId } = req.body;
  if (!apiKey || !accountId) {
    return res.status(400).json({ ok: false, error: "Missing apiKey or accountId" });
  }

  const valid = await verifyInventoryPlannerCredentials(apiKey, accountId);
  if (!valid) {
    return res.status(401).json({ ok: false, error: "Inventory Planner rejected those credentials — double-check your API key and Account ID under Account → Settings → API." });
  }

  const shopData = await db.getShop(shop);
  if (!shopData) return res.status(401).json({ ok: false, error: "Install the app on this store first" });
  await db.saveShop(shop, { inventoryPlanner: { apiKey, accountId } });
  res.json({ ok: true });
});

app.post("/api/inventory-planner/sync", async (req, res) => {
  const shop = req.shop;
  const shopData = await db.getShop(shop);
  const config = shopData && shopData.inventoryPlanner;
  if (!config) return res.status(400).json({ ok: false, error: "Inventory Planner isn't connected for this shop yet" });

  try {
    const variants = await fetchUrgentVariants(config.apiKey, config.accountId);
    const results = [];

    for (const variant of variants) {
      const risk = evaluateReorderUrgency(variant);
      if (!risk.hasData) continue; // no forecast yet — skip, don't guess

      const label = variant.sku || variant.title || `variant ${variant.id}`;
      results.push({
        source: "Inventory Planner",
        item: `${label} — sells out in ~${risk.oosDays}d, reorder ${variant.replenishment}`,
        confidence: risk.urgency,
        action: risk.actToday ? "Flagged: act today" : "Flagged: monitor",
      });
    }

    res.json({ ok: true, count: results.length, results });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// -------------------------------------------------------------
app.get("/api/klaviyo/status", async (req, res) => {
  const shop = req.shop;
  const shopData = await db.getShop(shop);
  const connected = !!(shopData && shopData.klaviyo);
  res.json({ connected });
});

app.post("/api/klaviyo/connect", async (req, res) => {
  const shop = req.shop;
  const { apiKey, winbackListId } = req.body;
  if (!apiKey || !winbackListId) {
    return res.status(400).json({ ok: false, error: "Missing apiKey or winbackListId" });
  }

  const valid = await verifyKlaviyoCredentials(apiKey);
  if (!valid) {
    return res.status(401).json({ ok: false, error: "Klaviyo rejected that API key — double-check it in Klaviyo under Settings → API Keys." });
  }

  const shopData = await db.getShop(shop);
  if (!shopData) return res.status(401).json({ ok: false, error: "Install the app on this store first" });
  await db.saveShop(shop, { klaviyo: { apiKey, winbackListId } });
  res.json({ ok: true });
});

app.post("/api/klaviyo/sync", async (req, res) => {
  const shop = req.shop;
  const shopData = await db.getShop(shop);
  const config = shopData && shopData.klaviyo;
  if (!config) return res.status(400).json({ ok: false, error: "Klaviyo isn't connected for this shop yet" });

  try {
    const profiles = await fetchProfilesWithChurnRisk(config.apiKey);
    const onHold = await db.activeHoldEmails(shop);
    const results = [];

    for (const profile of profiles) {
      const risk = evaluateChurnRisk(profile);
      const email = (profile.attributes && profile.attributes.email) || profile.id;

      if (!risk.hasData) {
        // Not enough order history for Klaviyo to have computed a
        // score yet — skip, don't guess.
        continue;
      }

      let action;
      if (onHold.has(String(email).toLowerCase())) {
        // Cross-app rule: no win-back email while a complaint is open.
        action = "Held — customer has an open complaint in Gorgias";
      } else if (risk.atRisk) {
        await addProfileToList(config.apiKey, config.winbackListId, profile.id);
        action = "Added to win-back list";
      } else {
        action = "Left alone — low churn risk";
      }

      results.push({
        source: "Klaviyo",
        item: `${email} — churn risk ${(risk.churnProbability * 100).toFixed(0)}%`,
        confidence: Number(risk.churnProbability.toFixed(2)),
        action,
      });
    }

    res.json({ ok: true, count: results.length, results });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// -------------------------------------------------------------
const CONFIDENCE_THRESHOLD = 0.85;

app.get("/api/gorgias/status", async (req, res) => {
  const shop = req.shop;
  const shopData = await db.getShop(shop);
  const connected = !!(shopData && shopData.gorgias);
  res.json({ connected });
});

app.post("/api/gorgias/connect", async (req, res) => {
  const shop = req.shop;
  const { subdomain, email, apiKey } = req.body;
  if (!subdomain || !email || !apiKey) {
    return res.status(400).json({ ok: false, error: "Missing subdomain, email, or apiKey" });
  }

  const valid = await verifyGorgiasCredentials(subdomain, email, apiKey);
  if (!valid) {
    return res.status(401).json({ ok: false, error: "Gorgias rejected those credentials — double-check your subdomain, email, and API key." });
  }

  const shopData = await db.getShop(shop);
  if (!shopData) return res.status(401).json({ ok: false, error: "Install the app on this store first" });
  await db.saveShop(shop, { gorgias: { subdomain, email, apiKey } });
  res.json({ ok: true });
});

app.post("/api/gorgias/sync", async (req, res) => {
  const shop = req.shop;
  const shopData = await db.getShop(shop);
  const config = shopData && shopData.gorgias;
  if (!config) return res.status(400).json({ ok: false, error: "Gorgias isn't connected for this shop yet" });

  try {
    const tickets = await fetchOpenGorgiasTickets(config.subdomain, config.email, config.apiKey);
    const results = [];

    for (const ticket of tickets) {
      const decision = classifyTicket(ticket);
      let action = "Left untouched — below confidence threshold";

      if (decision.confidence >= CONFIDENCE_THRESHOLD) {
        const tagName = decision.category === "escalate" ? "decisionporter-priority" : "decisionporter-routine";
        await addGorgiasTag(config.subdomain, config.email, config.apiKey, ticket.id, tagName);
        action = `Tagged: ${tagName}`;
      } else {
        action = "Held for manual review (low confidence)";
      }

      results.push({
        source: "Gorgias",
        item: `#${ticket.id} — ${ticket.subject || "(no subject)"}`,
        confidence: decision.confidence,
        action,
      });
    }

    res.json({ ok: true, count: results.length, results });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// -------------------------------------------------------------
// The embedded admin dashboard the merchant actually sees
// -------------------------------------------------------------
// The page is read once at startup and the app's public API key is
// filled in so App Bridge can start. (The API key is public; the
// SECRET never goes to the browser.)
const fs = require("fs");
const DASHBOARD_HTML = fs
  .readFileSync(path.join(__dirname, "public", "index.html"), "utf8")
  .replace("__SHOPIFY_API_KEY__", String(SHOPIFY_API_KEY || "").replace(/[^A-Za-z0-9_-]/g, ""));

app.get("/", (req, res) => {
  res.type("html").send(DASHBOARD_HTML);
});

// -------------------------------------------------------------
// DECISION ENGINE: settings, run, decision log (see engine.js)
// -------------------------------------------------------------
function buildDeps(shop, shopData) {
  return {
    store: db.store,
    gorgias: clients.makeGorgiasClient({ config: shopData.gorgias, fetch }),
    shopify: clients.makeShopifyClient({ shop, getToken: getShopifyToken, fetch, apiVersion: API_VERSION }),
    klaviyo: shopData.klaviyo ? clients.makeKlaviyoClient({ config: shopData.klaviyo, fetch }) : null,
    inventoryPlanner: shopData.inventoryPlanner ? clients.makeInventoryPlannerClient({ config: shopData.inventoryPlanner, fetch }) : null,
    now: new Date(),
  };
}

const running = new Set(); // shops with a cycle in progress

async function runCycleForShop(shop) {
  if (running.has(shop)) return { skipped: "already running" };
  running.add(shop);
  try {
    const shopData = await db.getShop(shop);
    if (!shopData || !shopData.accessToken) throw new Error("Shop not installed");
    if (!shopData.gorgias) throw new Error("Connect Gorgias first — every rule starts from support tickets");
    const summary = await engine.runCycle({ shop, shopData, settings: shopData.settings, deps: buildDeps(shop, shopData) });
    await db.saveShop(shop, {
      lastCycleAt: new Date().toISOString(),
      lastCycleError: summary.errors.length ? summary.errors.slice(0, 3).join(" | ") : null,
    });
    return summary;
  } catch (err) {
    await db.saveShop(shop, { lastCycleAt: new Date().toISOString(), lastCycleError: err.message }).catch(() => {});
    throw err;
  } finally {
    running.delete(shop);
  }
}

app.get("/api/settings", async (req, res) => {
  const shopData = await db.getShop(req.shop);
  if (!shopData) return res.status(401).json({ ok: false, error: "Install the app on this store first" });
  const settings = engine.normalizeSettings(shopData.settings);
  res.json({
    ok: true,
    settings,
    live: engine.isLive(settings, shopData),
    plan: shopData.plan || null,
    lastCycleAt: shopData.lastCycleAt,
    lastCycleError: shopData.lastCycleError,
    tags: engine.TAGS,
  });
});

app.post("/api/settings", async (req, res) => {
  const shopData = await db.getShop(req.shop);
  if (!shopData) return res.status(401).json({ ok: false, error: "Install the app on this store first" });
  const current = engine.normalizeSettings(shopData.settings);
  const incoming = req.body || {};
  const next = engine.normalizeSettings({
    ...current,
    ...incoming,
    rules: { ...current.rules, ...(incoming.rules || {}) },
  });
  if (next.mode === "live" && !shopData.plan) {
    return res.status(402).json({ ok: false, error: "Choose a plan to switch on live mode. Shadow mode stays free." });
  }
  await db.saveShop(req.shop, { settings: next });
  res.json({ ok: true, settings: next, live: engine.isLive(next, shopData) });
});

app.post("/api/run", async (req, res) => {
  try {
    const summary = await runCycleForShop(req.shop);
    res.json({ ok: true, summary });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get("/api/decisions", async (req, res) => {
  const limit = Number(req.query.limit) || 100;
  res.json({ ok: true, decisions: await db.listDecisions(req.shop, limit) });
});

app.get("/api/access-log", async (req, res) => {
  res.json({ ok: true, entries: await db.listAccessLog(req.shop, Number(req.query.limit) || 100) });
});

app.get("/api/summary", async (req, res) => {
  const days = Number(req.query.days) || 7;
  res.json({ ok: true, ...(await db.decisionSummary(req.shop, days)) });
});

// Runs every connected shop on a timer. On Render this needs an
// instance that doesn't sleep (the free tier spins down when idle).
const CYCLE_MINUTES = Math.max(5, Number(process.env.CYCLE_MINUTES) || 15);
async function runAllShops() {
  let shops = [];
  try {
    shops = await db.listShopsForCycle();
  } catch (err) {
    return console.error("Scheduler: could not list shops:", err.message);
  }
  for (const shop of shops) {
    try {
      const s = await runCycleForShop(shop);
      if (!s.skipped) console.log(`Cycle ${shop}: ${s.mode}, held ${s.held}, released ${s.released}, vip ${s.vip}, sku flags ${s.skuFlags}, errors ${s.errors.length}`);
    } catch (err) {
      console.error(`Cycle failed for ${shop}:`, err.message);
    }
  }
}

// -------------------------------------------------------------
// Safety net: if anything above throws unexpectedly, send back a
// generic message instead of Express's default behavior of leaking
// a full stack trace (file paths, dependency structure) to whoever
// sent the request. Must be registered last, after all routes.
// -------------------------------------------------------------
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, error: "Something went wrong on our end." });
});

db.migrate()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`DecisionPorter running on port ${PORT}; decision cycle every ${CYCLE_MINUTES} min`);
      if (process.env.DISABLE_SCHEDULER !== "true") {
        setTimeout(runAllShops, 30 * 1000);
        setInterval(runAllShops, CYCLE_MINUTES * 60 * 1000);
        // Retention: delete expired personal data at startup and daily.
        const purge = () => db.purgeExpired()
          .then((r) => console.log(`Retention purge (>${db.RETENTION_DAYS}d): ${JSON.stringify(r)}`))
          .catch((err) => console.error("Retention purge failed:", err.message));
        setTimeout(purge, 60 * 1000);
        setInterval(purge, 24 * 60 * 60 * 1000);
      }
      console.log(`Set APP_URL in .env to your public URL, then install via /auth?shop=your-store.myshopify.com`);
    });
  })
  .catch((err) => {
    console.error("Could not connect to the database — check DATABASE_URL in your .env:", err.message);
    process.exit(1);
  });
