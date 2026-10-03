// End-to-end smoke test: starts the real server against TEST_DATABASE_URL
// and calls it the way the embedded admin and Shopify webhooks do.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { spawn } = require("child_process");
const path = require("path");

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  test("server smoke test (skipped: set TEST_DATABASE_URL)", { skip: true }, () => {});
} else {
  const PORT = 3999;
  const API_KEY = "testkey";
  const SECRET = "testsecret";
  const SHOP = `smoke-${Date.now()}.myshopify.com`;
  const base = `http://localhost:${PORT}`;
  const env = {
    ...process.env,
    DATABASE_URL: url,
    ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64"),
    SHOPIFY_API_KEY: API_KEY,
    SHOPIFY_API_SECRET: SECRET,
    APP_URL: base,
    PORT: String(PORT),
    DISABLE_SCHEDULER: "true",
  };
  let server;
  let db;

  function sessionToken(shop) {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const head = b64({ alg: "HS256", typ: "JWT" });
    const body = b64({ iss: `https://${shop}/admin`, dest: `https://${shop}`, aud: API_KEY, exp: now + 60, nbf: now - 5, sub: "1" });
    const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
    return `${head}.${body}.${sig}`;
  }
  const api = (p, opts = {}) => fetch(base + p, {
    ...opts,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken(SHOP)}`, ...(opts.headers || {}) },
  });
  function webhook(topic, payload, goodSig = true) {
    const raw = JSON.stringify(payload);
    const hmac = crypto.createHmac("sha256", goodSig ? SECRET : "wrong").update(raw).digest("base64");
    return fetch(`${base}/webhooks/${topic}`, { method: "POST", body: raw, headers: { "Content-Type": "application/json", "X-Shopify-Hmac-Sha256": hmac, "X-Shopify-Shop-Domain": SHOP } });
  }

  test.before(async () => {
    server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
    server.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("server did not start")), 15000);
      server.stdout.on("data", (d) => { if (String(d).includes("running on port")) { clearTimeout(t); resolve(); } });
    });
    process.env.DATABASE_URL = url;
    process.env.ENCRYPTION_KEY = env.ENCRYPTION_KEY;
    db = require("../db");
    await db.saveShop(SHOP, { accessToken: "shpat_test", installedAt: new Date().toISOString() });
  });

  test.after(async () => {
    server.kill();
    await db.deleteShop(SHOP).catch(() => {});
    await db.pool.end();
  });

  test("dashboard page is served with the API key filled in", async () => {
    const html = await (await fetch(base + "/")).text();
    assert.match(html, /content="testkey"/);
    assert.match(html, /Decision log/);
  });

  test("API rejects requests without a valid session token", async () => {
    const r = await fetch(base + "/api/settings");
    assert.equal(r.status, 401);
  });

  test("settings default to shadow; live is refused without a plan", async () => {
    const r = await (await api("/api/settings")).json();
    assert.equal(r.settings.mode, "shadow");
    assert.equal(r.live, false);
    const live = await api("/api/settings", { method: "POST", body: JSON.stringify({ mode: "live" }) });
    assert.equal(live.status, 402);
    const ok = await (await api("/api/settings", { method: "POST", body: JSON.stringify({ vipThreshold: 750, rules: { skuFlags: false } }) })).json();
    assert.equal(ok.settings.vipThreshold, 750);
    assert.equal(ok.settings.rules.skuFlags, false);
    assert.equal(ok.settings.rules.holdReviews, true);
  });

  test("running the engine without Gorgias explains what to do", async () => {
    const r = await api("/api/run", { method: "POST", body: "{}" });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /Connect Gorgias first/);
  });

  test("decision log and summary endpoints respond", async () => {
    await db.store.logDecision({ shop: SHOP, rule: "holdReviews", status: "would_apply", mode: "shadow", customerEmail: "c@x.com", subjectId: "1", summary: "s", action: "a" });
    const d = await (await api("/api/decisions")).json();
    assert.equal(d.decisions.length, 1);
    const s = await (await api("/api/summary?days=7")).json();
    assert.equal(s.counts[0].n, 1);
  });

  test("viewing customer data is recorded in the access log with the staff user", async () => {
    await api("/api/decisions");
    await api("/api/settings"); // a plain settings read is not logged
    const log = (await (await api("/api/access-log")).json()).entries;
    assert.ok(log.some((e) => e.action === "GET /api/decisions" && e.actor === "shopify-user:1"));
    assert.ok(!log.some((e) => e.action === "GET /api/settings"));
  });

  test("privacy webhooks verify the signature and erase customer data", async () => {
    assert.equal((await webhook("customers/redact", { shop_domain: SHOP, customer: { email: "c@x.com" } }, false)).status, 401);
    assert.equal((await webhook("customers/data_request", { shop_domain: SHOP, customer: { email: "c@x.com" }, data_request: { id: 1 } })).status, 200);
    assert.equal((await webhook("customers/redact", { shop_domain: SHOP, customer: { email: "c@x.com" } })).status, 200);
    assert.deepEqual(await db.customerDataSummary(SHOP, "c@x.com"), { decisions: 0, holds: 0 });
    assert.equal((await webhook("shop/redact", { shop_domain: SHOP })).status, 200);
    assert.equal(await db.getShop(SHOP), null);
  });
}
