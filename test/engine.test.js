// Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const { runCycle, classifyTicket, isComplaint, productSignal, normalizeSettings, isLive, TAGS } = require("../engine");

const DAY = 24 * 60 * 60 * 1000;

// ---------- In-memory fakes ----------
function memoryStore() {
  const s = { holds: [], decisions: [], signals: [], nextId: 1 };
  return {
    s,
    async listActiveHolds(shop) { return s.holds.filter((h) => h.shop === shop && !h.releasedAt); },
    async createHold(h) { s.holds.push({ id: s.nextId++, ...h }); },
    async updateHold({ holdId, mode, shopifyCustomerId }) {
      const h = s.holds.find((x) => x.id === holdId); h.mode = mode; h.shopifyCustomerId = shopifyCustomerId;
    },
    async releaseHold({ holdId, releasedAt, reason }) {
      const h = s.holds.find((x) => x.id === holdId); h.releasedAt = releasedAt; h.reason = reason;
    },
    async logDecision(d) { s.decisions.push(d); },
    async hasDecision({ shop, rule, subjectId, since, statuses }) {
      return s.decisions.some((d) => d.shop === shop && d.rule === rule && d.subjectId === subjectId &&
        (!since || d.createdAt >= since) && (!statuses || statuses.includes(d.status)));
    },
    async addSkuSignal(sig) {
      if (s.signals.some((x) => x.shop === sig.shop && x.ticketId === sig.ticketId && x.productId === sig.productId)) return false;
      s.signals.push(sig); return true;
    },
    async hasSkuSignalForTicket({ shop, ticketId }) { return s.signals.some((x) => x.shop === shop && x.ticketId === ticketId); },
    async countSkuSignals({ shop, productId, signal, since }) {
      return s.signals.filter((x) => x.shop === shop && x.productId === productId && x.signal === signal && x.createdAt >= since).length;
    },
  };
}

function fakes({ tickets, customers = {}, orders = {}, reorder = new Map() }) {
  const calls = { gorgiasTags: [], shopifyAdd: [], shopifyRemove: [], klaviyo: [] };
  return {
    calls,
    gorgias: {
      async fetchRecentTickets() { return tickets; },
      async addTag(id, tag) { calls.gorgiasTags.push([id, tag]); },
    },
    shopify: {
      async findCustomerByEmail(email) { return customers[email] || null; },
      async latestOrderProducts(customerId) { return orders[customerId] || []; },
      async addTags(id, tags) { calls.shopifyAdd.push([id, ...tags]); },
      async removeTags(id, tags) { calls.shopifyRemove.push([id, ...tags]); },
    },
    klaviyo: { async setComplaintFlag(email, v) { calls.klaviyo.push([email, v]); } },
    inventoryPlanner: { async reorderBySku() { return reorder; } },
  };
}

const ticket = (id, email, subject, status = "open") => ({ id, status, subject, customer: { email } });
const paid = { plan: "growth" };
const LIVE = { mode: "live" };

// ---------- Classifier ----------
test("classifier escalates refund demands and leaves no-signal tickets for review", () => {
  assert.equal(classifyTicket({ subject: "I want a refund, this is unacceptable" }).category, "escalate");
  assert.equal(classifyTicket({ subject: "hello" }).category, "needs_review");
  assert.equal(isComplaint({ subject: "Item arrived damaged" }), true);
  assert.equal(isComplaint({ subject: "Where is my tracking number?" }), false);
});

test("product signal detects sizing before quality", () => {
  assert.equal(productSignal({ subject: "Belt runs small" }), "sizing");
  assert.equal(productSignal({ subject: "Buckle broken on arrival" }), "quality");
  assert.equal(productSignal({ subject: "Love it" }), null);
});

test("settings are normalized and live needs a paid plan", () => {
  const s = normalizeSettings({ mode: "live", vipThreshold: "-5", rules: { holdReviews: 0, bogus: true } });
  assert.equal(s.vipThreshold, 0);
  assert.equal(s.rules.holdReviews, false);
  assert.equal("bogus" in s.rules, false);
  assert.equal(isLive(s, { plan: null }), false);
  assert.equal(isLive(s, paid), true);
  assert.equal(normalizeSettings(null).mode, "shadow");
});

// ---------- Rules 1 + 2 ----------
test("shadow mode logs a hold but writes nothing to any app", async () => {
  const store = memoryStore();
  const f = fakes({ tickets: [ticket(1, "a@x.com", "Refund please, item damaged")], customers: { "a@x.com": { id: "gid://shopify/Customer/1", amountSpent: 50 } } });
  const out = await runCycle({ shop: "s", shopData: paid, settings: {}, deps: { store, ...f } });
  assert.equal(out.mode, "shadow");
  assert.equal(out.held, 1);
  assert.deepEqual(f.calls.shopifyAdd, []);
  assert.deepEqual(f.calls.klaviyo, []);
  assert.equal(store.s.decisions[0].status, "would_apply");
});

test("live without a paid plan stays in shadow", async () => {
  const store = memoryStore();
  const f = fakes({ tickets: [ticket(1, "a@x.com", "Refund please")], customers: { "a@x.com": { id: "C1", amountSpent: 0 } } });
  const out = await runCycle({ shop: "s", shopData: { plan: null }, settings: LIVE, deps: { store, ...f } });
  assert.equal(out.mode, "shadow");
  assert.deepEqual(f.calls.shopifyAdd, []);
});

test("live hold tags the customer and sets the Klaviyo flag, then releases when the ticket closes", async () => {
  const store = memoryStore();
  const customers = { "a@x.com": { id: "C1", amountSpent: 10 } };
  const f1 = fakes({ tickets: [ticket(1, "A@x.com", "This is unacceptable")], customers });
  await runCycle({ shop: "s", shopData: paid, settings: LIVE, deps: { store, ...f1 } });
  assert.deepEqual(f1.calls.shopifyAdd, [["C1", TAGS.holdReview]]);
  assert.deepEqual(f1.calls.klaviyo, [["a@x.com", true]]);

  // Same ticket still open: nothing new happens.
  const f2 = fakes({ tickets: [ticket(1, "a@x.com", "This is unacceptable")], customers });
  const out2 = await runCycle({ shop: "s", shopData: paid, settings: LIVE, deps: { store, ...f2 } });
  assert.equal(out2.held, 0);
  assert.equal(out2.released, 0);

  // Ticket closed: tag removed, flag cleared.
  const f3 = fakes({ tickets: [ticket(1, "a@x.com", "This is unacceptable", "closed")], customers });
  const out3 = await runCycle({ shop: "s", shopData: paid, settings: LIVE, deps: { store, ...f3 } });
  assert.equal(out3.released, 1);
  assert.deepEqual(f3.calls.shopifyRemove, [["C1", TAGS.holdReview]]);
  assert.deepEqual(f3.calls.klaviyo, [["a@x.com", false]]);
});

test("a hold is released after maxHoldDays even if the ticket stays open (delay, never a permanent skip)", async () => {
  const store = memoryStore();
  const customers = { "a@x.com": { id: "C1", amountSpent: 10 } };
  const start = new Date("2026-10-01T00:00:00Z");
  await runCycle({ shop: "s", shopData: paid, settings: LIVE, deps: { store, ...fakes({ tickets: [ticket(1, "a@x.com", "refund")], customers }), now: start } });
  const f = fakes({ tickets: [ticket(1, "a@x.com", "refund")], customers });
  const out = await runCycle({ shop: "s", shopData: paid, settings: LIVE, deps: { store, ...f, now: new Date(start.getTime() + 15 * DAY) } });
  assert.equal(out.released, 1);
  assert.deepEqual(f.calls.shopifyRemove, [["C1", TAGS.holdReview]]);
});

test("a shadow hold is applied for real once the store goes live", async () => {
  const store = memoryStore();
  const customers = { "a@x.com": { id: "C1", amountSpent: 10 } };
  const t = [ticket(1, "a@x.com", "refund")];
  await runCycle({ shop: "s", shopData: paid, settings: {}, deps: { store, ...fakes({ tickets: t, customers }) } });
  const f = fakes({ tickets: t, customers });
  await runCycle({ shop: "s", shopData: paid, settings: LIVE, deps: { store, ...f } });
  assert.deepEqual(f.calls.shopifyAdd, [["C1", TAGS.holdReview]]);
  assert.equal(store.s.holds[0].mode, "live");
});

test("routine questions do not start a hold", async () => {
  const store = memoryStore();
  const f = fakes({ tickets: [ticket(1, "a@x.com", "When will my order ship?")], customers: { "a@x.com": { id: "C1", amountSpent: 0 } } });
  const out = await runCycle({ shop: "s", shopData: paid, settings: LIVE, deps: { store, ...f } });
  assert.equal(out.held, 0);
});

// ---------- Rule 4 ----------
test("VIP tickets are tagged once; shadow decisions don't block the live tag later", async () => {
  const store = memoryStore();
  const customers = { "v@x.com": { id: "C9", amountSpent: 1200, currency: "$" }, "n@x.com": { id: "C8", amountSpent: 40 } };
  const t = [ticket(7, "v@x.com", "question about my order"), ticket(8, "n@x.com", "question")];
  const shadow = fakes({ tickets: t, customers });
  const s1 = await runCycle({ shop: "s", shopData: paid, settings: {}, deps: { store, ...shadow } });
  assert.equal(s1.vip, 1);
  assert.deepEqual(shadow.calls.gorgiasTags, []);

  const live = fakes({ tickets: t, customers });
  await runCycle({ shop: "s", shopData: paid, settings: LIVE, deps: { store, ...live } });
  assert.deepEqual(live.calls.gorgiasTags, [[7, TAGS.vip]]);

  const again = fakes({ tickets: t, customers });
  await runCycle({ shop: "s", shopData: paid, settings: LIVE, deps: { store, ...again } });
  assert.deepEqual(again.calls.gorgiasTags, []);
});

// ---------- Rule 3 ----------
test("three sizing complaints about one product flag it, with the Inventory Planner reorder note", async () => {
  const store = memoryStore();
  const customers = {}; const orders = {};
  const tickets = [];
  for (let i = 1; i <= 3; i++) {
    customers[`c${i}@x.com`] = { id: `C${i}`, amountSpent: 20 };
    orders[`C${i}`] = [{ productId: "gid://shopify/Product/55", title: "Classic Belt", sku: "BELT-BLK-M" }];
    tickets.push(ticket(100 + i, `c${i}@x.com`, "The belt runs small", i === 3 ? "open" : "closed"));
  }
  const reorder = new Map([["BELT-BLK-M", { replenishment: 200, oos: 9 }]]);
  const f = fakes({ tickets, customers, orders, reorder });
  const out = await runCycle({ shop: "s", shopData: paid, settings: LIVE, deps: { store, ...f } });
  assert.equal(out.skuFlags, 1);
  assert.deepEqual(f.calls.shopifyAdd.filter((c) => c[0] === "gid://shopify/Product/55"), [["gid://shopify/Product/55", TAGS.sizing]]);
  const d = store.s.decisions.find((x) => x.rule === "skuFlags");
  assert.match(d.summary, /3 sizing complaints/);
  assert.match(d.summary, /Inventory Planner recommends reordering 200/);

  // Re-running doesn't double-count the same tickets or re-flag.
  const f2 = fakes({ tickets, customers, orders, reorder });
  let lookups = 0;
  const origLatest = f2.shopify.latestOrderProducts;
  f2.shopify.latestOrderProducts = async (id) => { lookups++; return origLatest(id); };
  const out2 = await runCycle({ shop: "s", shopData: paid, settings: LIVE, deps: { store, ...f2 } });
  assert.equal(out2.skuFlags, 0);
  assert.equal(lookups, 0, "already-counted tickets are not looked up again");
});

test("complaints about multi-product orders are not attributed to a product", async () => {
  const store = memoryStore();
  const customers = {}; const orders = {}; const tickets = [];
  for (let i = 1; i <= 3; i++) {
    customers[`c${i}@x.com`] = { id: `C${i}`, amountSpent: 20 };
    orders[`C${i}`] = [{ productId: "P1", title: "A" }, { productId: "P2", title: "B" }];
    tickets.push(ticket(i, `c${i}@x.com`, "too small"));
  }
  const out = await runCycle({ shop: "s", shopData: paid, settings: LIVE, deps: { store, ...fakes({ tickets, customers, orders }) } });
  assert.equal(out.skuFlags, 0);
});

test("turning a rule off skips it", async () => {
  const store = memoryStore();
  const f = fakes({ tickets: [ticket(1, "a@x.com", "refund")], customers: { "a@x.com": { id: "C1", amountSpent: 5000 } } });
  const out = await runCycle({ shop: "s", shopData: paid, settings: { mode: "live", rules: { holdReviews: false, pauseMarketing: false, vipEscalation: false } }, deps: { store, ...f } });
  assert.equal(out.held, 0);
  assert.equal(out.vip, 0);
  assert.deepEqual(f.calls.gorgiasTags, []);
});
