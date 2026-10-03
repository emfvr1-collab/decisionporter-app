// Database tests. They run only when TEST_DATABASE_URL points at a
// throwaway Postgres database (they create and delete rows):
//   TEST_DATABASE_URL=postgresql://postgres@localhost:5432/dptest npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  test("database tests (skipped: set TEST_DATABASE_URL)", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = url;
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString("base64");
  const db = require("../db");
  const engine = require("../engine");
  const SHOP = `test-${Date.now()}.myshopify.com`;

  test.after(async () => {
    await db.deleteShop(SHOP);
    await db.pool.end();
  });

  test("migrate is safe to run twice", async () => {
    await db.migrate();
    await db.migrate();
  });

  test("tokens and settings round-trip; secrets are encrypted at rest", async () => {
    await db.saveShop(SHOP, { accessToken: "shpat_x", refreshToken: "shprt_y", tokenExpiresAt: new Date().toISOString(), gorgias: { subdomain: "s", email: "e", apiKey: "k" } });
    await db.saveShop(SHOP, { settings: { mode: "shadow", vipThreshold: 300 } });
    const shop = await db.getShop(SHOP);
    assert.equal(shop.accessToken, "shpat_x");
    assert.equal(shop.refreshToken, "shprt_y");
    assert.equal(shop.settings.vipThreshold, 300);
    assert.equal(shop.gorgias.apiKey, "k");
    const raw = await db.pool.query("SELECT access_token, refresh_token FROM shops WHERE shop = $1", [SHOP]);
    assert.match(raw.rows[0].access_token, /^enc:v1:/);
    assert.match(raw.rows[0].refresh_token, /^enc:v1:/);
    assert.ok((await db.listShopsForCycle()).includes(SHOP));
  });

  test("a full engine cycle against the real store: hold, log, summary, release", async () => {
    const calls = [];
    const customers = { "buyer@x.com": { id: "C1", amountSpent: 900, currency: "USD " } };
    const deps = (tickets, now) => ({
      store: db.store,
      gorgias: { fetchRecentTickets: async () => tickets, addTag: async (id, t) => calls.push(["gorgias", id, t]) },
      shopify: {
        findCustomerByEmail: async (e) => customers[e] || null,
        latestOrderProducts: async () => [{ productId: "P1", title: "Belt", sku: "B1" }],
        addTags: async (id, t) => calls.push(["add", id, ...t]),
        removeTags: async (id, t) => calls.push(["remove", id, ...t]),
      },
      klaviyo: { setComplaintFlag: async (e, v) => calls.push(["klaviyo", e, v]) },
      inventoryPlanner: null,
      now,
    });
    const open = [{ id: 11, status: "open", subject: "Refund now, the belt is too small", customer: { email: "Buyer@x.com" } }];
    const live = { plan: "growth" };
    const s1 = await engine.runCycle({ shop: SHOP, shopData: live, settings: { mode: "live" }, deps: deps(open, new Date()) });
    assert.equal(s1.held, 1);
    assert.equal(s1.vip, 1);
    assert.equal(s1.errors.length, 0);

    // Second run: the unique active-hold index and dedupe hold.
    const s2 = await engine.runCycle({ shop: SHOP, shopData: live, settings: { mode: "live" }, deps: deps(open, new Date()) });
    assert.equal(s2.held, 0);
    assert.equal(s2.vip, 0);
    assert.deepEqual([...(await db.activeHoldEmails(SHOP))], ["buyer@x.com"]);

    const closed = [{ ...open[0], status: "closed" }];
    const s3 = await engine.runCycle({ shop: SHOP, shopData: live, settings: { mode: "live" }, deps: deps(closed, new Date()) });
    assert.equal(s3.released, 1);
    assert.equal((await db.activeHoldEmails(SHOP)).size, 0);

    const log = await db.listDecisions(SHOP);
    assert.ok(log.length >= 3);
    assert.ok(log.some((d) => d.rule === "vipEscalation" && d.status === "applied"));
    const summary = await db.decisionSummary(SHOP, 7);
    assert.ok(summary.counts.length >= 2);
    assert.equal(summary.activeHolds, 0);
    assert.ok(calls.some((c) => c[0] === "remove"));
  });

  test("customers/redact erases that customer's rows only", async () => {
    await db.store.logDecision({ shop: SHOP, rule: "x", status: "applied", mode: "live", customerEmail: "other@x.com" });
    const before = await db.customerDataSummary(SHOP, "BUYER@x.com");
    assert.ok(before.decisions > 0);
    await db.redactCustomer(SHOP, "buyer@x.com");
    const after = await db.customerDataSummary(SHOP, "buyer@x.com");
    assert.deepEqual(after, { decisions: 0, holds: 0 });
    assert.equal((await db.customerDataSummary(SHOP, "other@x.com")).decisions, 1);
  });

  test("deleteShop removes everything for the shop", async () => {
    await db.deleteShop(SHOP);
    assert.equal(await db.getShop(SHOP), null);
    const left = await db.pool.query("SELECT count(*)::int AS n FROM decisions WHERE shop = $1", [SHOP]);
    assert.equal(left.rows[0].n, 0);
  });
}
