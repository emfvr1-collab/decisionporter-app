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

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Config from your .env file (see .env.example) ----
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const APP_URL = process.env.APP_URL; // e.g. https://your-app.onrender.com
const SCOPES = "read_orders,read_products,write_products"; // adjust once you wire in real integrations

app.use(express.json());
app.use("/public", express.static(path.join(__dirname, "public")));

// -------------------------------------------------------------
// STEP 1: Start install — Shopify sends the merchant here first
// -------------------------------------------------------------
app.get("/auth", (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send("Missing ?shop= parameter");

  const state = crypto.randomBytes(16).toString("hex");
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
  const { shop, code, hmac } = req.query;
  if (!shop || !code || !hmac) return res.status(400).send("Missing required parameters");

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

  if (generatedHash !== hmac) {
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

    // Save the shop + token
    await db.saveShop(shop, { accessToken: tokenData.access_token, installedAt: new Date().toISOString() });

    // Register the webhooks Shopify requires
    await registerMandatoryWebhooks(shop, tokenData.access_token);
  } catch (err) {
    console.error("Install failed:", err.message);
    return res.status(502).send("Could not reach Shopify to finish installing — please try again.");
  }

  // Send the merchant into the app
  res.redirect(`/?shop=${shop}`);
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
      await fetch(`https://${shop}/admin/api/2024-10/webhooks.json`, {
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
    const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
    const generatedHash = crypto
      .createHmac("sha256", SHOPIFY_API_SECRET)
      .update(req.rawBody || "", "utf8")
      .digest("base64");
    return hmacHeader === generatedHash;
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
app.post("/webhooks/customers/data_request", (req, res) => {
  if (!verifyWebhookHmac(req)) return res.sendStatus(401);
  // This starter app stores no customer personal data — just log
  // the request so you have a record of it, and respond OK.
  console.log("Customer data request received:", req.body);
  res.sendStatus(200);
});

// -------------------------------------------------------------
// REQUIRED webhook #3: erase a specific customer's data
// -------------------------------------------------------------
app.post("/webhooks/customers/redact", (req, res) => {
  if (!verifyWebhookHmac(req)) return res.sendStatus(401);
  console.log("Customer redact request received:", req.body);
  res.sendStatus(200);
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
// BILLING: create a recurring charge for one of your 3 plans
// -------------------------------------------------------------
const PLANS = {
  starter: { name: "Starter", price: "29.00" },
  growth: { name: "Growth", price: "79.00" },
  scale: { name: "Scale", price: "199.00" },
};

app.get("/billing/select/:plan", async (req, res) => {
  const { shop } = req.query;
  const plan = PLANS[req.params.plan];
  if (!shop || !plan) return res.status(400).send("Missing shop or unknown plan");

  const shopData = await db.getShop(shop);
  const accessToken = shopData && shopData.accessToken;
  if (!accessToken) return res.status(401).send("Shop not installed");

  const charge = {
    recurring_application_charge: {
      name: `DecisionPorter — ${plan.name}`,
      price: plan.price,
      return_url: `${APP_URL}/billing/callback?shop=${shop}`,
      trial_days: 14,
      test: process.env.BILLING_TEST_MODE === "true", // keep true until you launch for real
    },
  };

  try {
    const response = await fetch(
      `https://${shop}/admin/api/2024-10/recurring_application_charges.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify(charge),
      }
    );
    const data = await response.json();

    if (data.recurring_application_charge && data.recurring_application_charge.confirmation_url) {
      res.redirect(data.recurring_application_charge.confirmation_url);
    } else {
      res.status(500).json(data);
    }
  } catch (err) {
    console.error("Billing charge failed:", err.message);
    res.status(502).send("Could not reach Shopify to set up billing — please try again.");
  }
});

app.get("/billing/callback", (req, res) => {
  // Shopify sends the merchant back here after they approve the charge.
  // In a real app, you'd activate the charge_id via the Admin API here.
  res.redirect(`/?shop=${req.query.shop}&billing=confirmed`);
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

// ---- The actual decision logic ----
// This is a simple, transparent, keyword-based classifier — a real
// starting point, not a trained ML model. It's deliberately easy to
// read and to extend. A natural next upgrade is swapping this
// function for a call to a hosted classifier or an LLM, without
// changing anything else in the app.
const ESCALATE_KEYWORDS = [
  "refund", "chargeback", "lawyer", "attorney", "scam", "fraud",
  "cancel my order", "never received", "sue", "furious", "unacceptable",
];
const URGENT_KEYWORDS = [
  "urgent", "asap", "immediately", "broken", "damaged", "wrong item", "missing",
];
const ROUTINE_KEYWORDS = [
  "size", "sizing", "color", "when will", "tracking", "status update", "how do i",
];

function classifyTicket(ticket) {
  const subject = (ticket.subject || "").toLowerCase();
  const summary = (ticket.summary && ticket.summary.content ? ticket.summary.content : "").toLowerCase();
  const text = `${subject} ${summary}`;

  let score = 0.3;
  const matched = [];

  ESCALATE_KEYWORDS.forEach((kw) => {
    if (text.includes(kw)) { score += 0.25; matched.push(kw); }
  });
  URGENT_KEYWORDS.forEach((kw) => {
    if (text.includes(kw)) { score += 0.15; matched.push(kw); }
  });
  ROUTINE_KEYWORDS.forEach((kw) => {
    if (text.includes(kw)) { score -= 0.1; matched.push(kw); }
  });

  score = Math.max(0, Math.min(1, score));

  // Confidence reflects how much signal we actually found — a ticket
  // with no keyword matches at all should NOT be auto-actioned.
  const confidence = matched.length > 0 ? Math.min(0.95, 0.55 + matched.length * 0.12) : 0.4;

  // Category comes from the final score, not just whether an escalate
  // keyword happened to fire — a ticket with three urgent signals
  // (broken, damaged, ASAP) should escalate even with no single
  // "refund"-style keyword present.
  let category = score >= 0.6 ? "escalate" : "routine";
  if (confidence < 0.6) category = "needs_review";

  return { category, urgencyScore: Number(score.toFixed(2)), confidence: Number(confidence.toFixed(2)), matched };
}

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
  const { shop } = req.query;
  const shopData = await db.getShop(shop);
  const connected = !!(shopData && shopData.judgeMe);
  res.json({ connected });
});

app.post("/api/judgeme/connect", async (req, res) => {
  const { shop, shopDomain, apiToken } = req.body;
  if (!shop || !shopDomain || !apiToken) {
    return res.status(400).json({ ok: false, error: "Missing shop, shopDomain, or apiToken" });
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
  const { shop } = req.body;
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
  const { shop } = req.query;
  const shopData = await db.getShop(shop);
  const connected = !!(shopData && shopData.inventoryPlanner);
  res.json({ connected });
});

app.post("/api/inventory-planner/connect", async (req, res) => {
  const { shop, apiKey, accountId } = req.body;
  if (!shop || !apiKey || !accountId) {
    return res.status(400).json({ ok: false, error: "Missing shop, apiKey, or accountId" });
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
  const { shop } = req.body;
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
  const { shop } = req.query;
  const shopData = await db.getShop(shop);
  const connected = !!(shopData && shopData.klaviyo);
  res.json({ connected });
});

app.post("/api/klaviyo/connect", async (req, res) => {
  const { shop, apiKey, winbackListId } = req.body;
  if (!shop || !apiKey || !winbackListId) {
    return res.status(400).json({ ok: false, error: "Missing shop, apiKey, or winbackListId" });
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
  const { shop } = req.body;
  const shopData = await db.getShop(shop);
  const config = shopData && shopData.klaviyo;
  if (!config) return res.status(400).json({ ok: false, error: "Klaviyo isn't connected for this shop yet" });

  try {
    const profiles = await fetchProfilesWithChurnRisk(config.apiKey);
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
      if (risk.atRisk) {
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
  const { shop } = req.query;
  const shopData = await db.getShop(shop);
  const connected = !!(shopData && shopData.gorgias);
  res.json({ connected });
});

app.post("/api/gorgias/connect", async (req, res) => {
  const { shop, subdomain, email, apiKey } = req.body;
  if (!shop || !subdomain || !email || !apiKey) {
    return res.status(400).json({ ok: false, error: "Missing shop, subdomain, email, or apiKey" });
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
  const { shop } = req.body;
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
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Sample decision data for the dashboard — replace with real calls
// to Gorgias / Klaviyo / Inventory Planner / Judge.me once you have
// API keys for each.
app.get("/api/sample-decisions", (req, res) => {
  res.json([
    { source: "Gorgias", item: "Ticket #4821 — sizing question", confidence: 0.94, action: "Routed: routine" },
    { source: "Gorgias", item: "Ticket #4822 — refund demand", confidence: 0.61, action: "Escalated to review" },
    { source: "Klaviyo", item: "Win-back send — segment 12", confidence: 0.79, action: "Sent" },
    { source: "Inventory Planner", item: "SKU 2214-BLK reorder check", confidence: 0.91, action: "Flagged: act today" },
    { source: "Judge.me", item: "Review #994 — possible spam", confidence: 0.47, action: "Held for review" },
  ]);
});

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
      console.log(`DecisionPorter starter app running on port ${PORT}`);
      console.log(`Set APP_URL in .env to your public URL, then install via /auth?shop=your-store.myshopify.com`);
    });
  })
  .catch((err) => {
    console.error("Could not connect to the database — check DATABASE_URL in your .env:", err.message);
    process.exit(1);
  });
