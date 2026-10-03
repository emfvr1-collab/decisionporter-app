const test = require("node:test");
const assert = require("node:assert/strict");
const clients = require("../clients");

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, ...opts });
    const { status = 200, body = {} } = (await handler(url, opts, calls.length)) || {};
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

function memDb(initial) {
  let row = { ...initial };
  return { saves: [], async getShop() { return row; }, async saveShop(shop, d) { this.saves.push(d); row = { ...row, ...d }; } };
}

test("token manager returns the stored token while it is still fresh", async () => {
  const db = memDb({ accessToken: "a1", refreshToken: "r1", tokenExpiresAt: new Date(Date.now() + 30 * 60e3) });
  const fetch = fakeFetch(() => ({}));
  const getToken = clients.makeTokenManager({ db, fetch, apiKey: "k", apiSecret: "s" });
  assert.equal(await getToken("x.myshopify.com"), "a1");
  assert.equal(fetch.calls.length, 0);
});

test("token manager refreshes once (form-encoded) and saves the NEW refresh token", async () => {
  const db = memDb({ accessToken: "a1", refreshToken: "r1", tokenExpiresAt: new Date(Date.now() + 10e3) });
  const fetch = fakeFetch(async () => {
    await new Promise((r) => setTimeout(r, 20));
    return { body: { access_token: "a2", refresh_token: "r2", expires_in: 3600 } };
  });
  const getToken = clients.makeTokenManager({ db, fetch, apiKey: "k", apiSecret: "s" });
  const [t1, t2] = await Promise.all([getToken("x.myshopify.com"), getToken("x.myshopify.com")]);
  assert.equal(t1, "a2");
  assert.equal(t2, "a2");
  assert.equal(fetch.calls.length, 1, "parallel callers must share one refresh");
  const call = fetch.calls[0];
  assert.equal(call.url, "https://x.myshopify.com/admin/oauth/access_token");
  assert.equal(call.headers["Content-Type"], "application/x-www-form-urlencoded");
  const body = new URLSearchParams(call.body);
  assert.equal(body.get("grant_type"), "refresh_token");
  assert.equal(body.get("refresh_token"), "r1");
  assert.equal(db.saves[0].refreshToken, "r2");
  assert.equal(db.saves[0].accessToken, "a2");
});

test("token manager surfaces a clear error when Shopify rejects the refresh", async () => {
  const db = memDb({ accessToken: "a1", refreshToken: "r1", tokenExpiresAt: new Date(Date.now() - 1000) });
  const fetch = fakeFetch(() => ({ status: 400, body: { error: "invalid_grant" } }));
  const getToken = clients.makeTokenManager({ db, fetch, apiKey: "k", apiSecret: "s" });
  await assert.rejects(getToken("x.myshopify.com"), /invalid_grant/);
});

test("shopify client parses customers, latest order products and tag errors", async () => {
  const recent = new Date().toISOString();
  const fetch = fakeFetch((url, opts) => {
    const q = JSON.parse(opts.body).query;
    if (q.includes("FindCustomer")) return { body: { data: { customers: { nodes: [{ id: "gid://shopify/Customer/1", amountSpent: { amount: "812.50", currencyCode: "USD" } }] } } } };
    if (q.includes("LatestOrder")) return { body: { data: { customer: { orders: { nodes: [{ createdAt: recent, lineItems: { nodes: [
      { sku: "B1", product: { id: "P1", title: "Belt" } }, { sku: "B1-2", product: { id: "P1", title: "Belt" } }, { sku: null, product: null }] } }] } } } } };
    if (q.includes("AddTags")) return { body: { data: { tagsAdd: { userErrors: [{ field: "id", message: "Not found" }] } } } };
    return { body: { data: {} } };
  });
  const shopify = clients.makeShopifyClient({ shop: "x.myshopify.com", getToken: async () => "t", fetch, apiVersion: "2026-07" });
  const c = await shopify.findCustomerByEmail('a"b@x.com');
  assert.equal(c.amountSpent, 812.5);
  assert.equal(JSON.parse(fetch.calls[0].body).variables.q, 'email:"ab@x.com"');
  assert.deepEqual(await shopify.latestOrderProducts(c.id), [{ productId: "P1", title: "Belt", sku: "B1" }]);
  await assert.rejects(shopify.addTags("P1", ["t"]), /Not found/);
});

test("klaviyo flag PATCHes an existing profile and never creates one", async () => {
  const fetch = fakeFetch((url) => (url.includes("filter=") && url.includes("nobody")
    ? { body: { data: [] } }
    : url.includes("filter=") ? { body: { data: [{ id: "PROF1" }] } } : { status: 200, body: {} }));
  const k = clients.makeKlaviyoClient({ config: { apiKey: "pk" }, fetch });
  assert.equal(await k.setComplaintFlag("a@x.com", true), true);
  const patch = fetch.calls[1];
  assert.equal(patch.method, "PATCH");
  assert.match(patch.url, /\/api\/profiles\/PROF1$/);
  assert.equal(JSON.parse(patch.body).data.attributes.properties.dp_open_complaint, true);
  assert.equal(await k.setComplaintFlag("nobody@x.com", true), false);
  assert.equal(fetch.calls.length, 3, "no write for a customer not in Klaviyo");
});
