/**
 * engine.js — DecisionPorter's cross-app decision engine
 * -----------------------------------------------------------------
 * This is the product. Each integration in server.js can be synced on
 * its own, but the reason DecisionPorter exists is to stop a store's
 * apps from working against each other when a customer is unhappy.
 * Every cycle (see runCycle) reads Gorgias tickets and applies four
 * cross-app rules:
 *
 *   1. holdReviews     Customer has an open complaint → tag them in
 *                      Shopify ("dp-hold-review") so Judge.me's
 *                      blacklist-by-tag skips review requests, and set
 *                      a Klaviyo property for Klaviyo-sent requests.
 *                      Released when the complaint closes or after
 *                      maxHoldDays — a DELAY, never a permanent skip
 *                      (selectively never asking unhappy customers for
 *                      reviews is "review gating", which Google and
 *                      the FTC prohibit).
 *   2. pauseMarketing  Same customers get dp_open_complaint=true on
 *                      their Klaviyo profile so promo flows can filter
 *                      them out; set back to false on release.
 *   3. skuFlags        Sizing/quality complaints are matched to the
 *                      product in the customer's latest order. Enough
 *                      of them in 30 days → product tag in Shopify
 *                      (Inventory Planner has no write API, so its
 *                      reorder recommendation is shown alongside).
 *   4. vipEscalation   Open tickets from customers whose lifetime spend
 *                      is above vipThreshold get a "decisionporter-vip"
 *                      tag in Gorgias so a Gorgias rule/view can put
 *                      them first.
 *
 * SHADOW MODE: unless the merchant has switched to live AND is on a
 * paid plan, nothing is written to any app — every decision is logged
 * as "would apply" so the merchant can see what DecisionPorter would
 * have done. That log is the free trial and the sales pitch.
 *
 * The engine takes all I/O as injected dependencies (store, gorgias,
 * shopify, klaviyo, inventoryPlanner), so it can be tested without
 * any network or database — see test/engine.test.js.
 * -----------------------------------------------------------------
 */

// ---------- Ticket classifier (moved here from server.js) ----------
// A simple, transparent, keyword-based classifier — a real starting
// point, not a trained model. Swappable for an LLM call later without
// changing anything else.
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

function ticketText(ticket) {
  const subject = (ticket.subject || "").toLowerCase();
  const summary = (ticket.summary && ticket.summary.content ? ticket.summary.content : "").toLowerCase();
  return `${subject} ${summary}`;
}

function classifyTicket(ticket) {
  const text = ticketText(ticket);
  let score = 0.3;
  const matched = [];
  ESCALATE_KEYWORDS.forEach((kw) => { if (text.includes(kw)) { score += 0.25; matched.push(kw); } });
  URGENT_KEYWORDS.forEach((kw) => { if (text.includes(kw)) { score += 0.15; matched.push(kw); } });
  ROUTINE_KEYWORDS.forEach((kw) => { if (text.includes(kw)) { score -= 0.1; matched.push(kw); } });
  score = Math.max(0, Math.min(1, score));
  // A ticket with no keyword matches at all should NOT be auto-actioned.
  const confidence = matched.length > 0 ? Math.min(0.95, 0.55 + matched.length * 0.12) : 0.4;
  let category = score >= 0.6 ? "escalate" : "routine";
  if (confidence < 0.6) category = "needs_review";
  return { category, urgencyScore: Number(score.toFixed(2)), confidence: Number(confidence.toFixed(2)), matched };
}

// A complaint = at least one escalate- or urgent-type signal, i.e. an
// unhappy customer, not a "where's my tracking number" question.
function isComplaint(ticket) {
  const text = ticketText(ticket);
  return ESCALATE_KEYWORDS.some((kw) => text.includes(kw)) || URGENT_KEYWORDS.some((kw) => text.includes(kw));
}

// Product-problem signals for rule 3. Order matters: first match wins.
const SKU_SIGNALS = [
  { signal: "sizing", keywords: ["runs small", "runs large", "runs big", "too small", "too big", "too tight", "too loose", "doesn't fit", "does not fit", "didn't fit", "wrong size", "sizing", "size"] },
  { signal: "quality", keywords: ["broken", "damaged", "defect", "defective", "ripped", "torn", "fell apart", "cracked", "peeling", "poor quality", "bad quality", "stopped working"] },
];

function productSignal(ticket) {
  const text = ticketText(ticket);
  for (const s of SKU_SIGNALS) {
    if (s.keywords.some((kw) => text.includes(kw))) return s.signal;
  }
  return null;
}

// ---------- Settings ----------
const DEFAULT_SETTINGS = Object.freeze({
  mode: "shadow", // "shadow" | "live"
  rules: { holdReviews: true, pauseMarketing: true, skuFlags: true, vipEscalation: true },
  vipThreshold: 500,    // lifetime spend in the store's currency
  skuFlagMin: 3,        // complaints about one product in skuWindowDays
  skuWindowDays: 30,
  maxHoldDays: 14,      // a hold never lasts longer than this
});

const TAGS = Object.freeze({
  holdReview: "dp-hold-review",
  vip: "decisionporter-vip",
  sizing: "dp-sizing-watch",
  quality: "dp-quality-watch",
});

function normalizeSettings(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const rules = { ...DEFAULT_SETTINGS.rules, ...(s.rules && typeof s.rules === "object" ? s.rules : {}) };
  for (const k of Object.keys(rules)) {
    if (!(k in DEFAULT_SETTINGS.rules)) delete rules[k];
    else rules[k] = Boolean(rules[k]);
  }
  const num = (v, def, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
  };
  return {
    mode: s.mode === "live" ? "live" : "shadow",
    rules,
    vipThreshold: num(s.vipThreshold, DEFAULT_SETTINGS.vipThreshold, 0, 1e7),
    skuFlagMin: Math.round(num(s.skuFlagMin, DEFAULT_SETTINGS.skuFlagMin, 1, 100)),
    skuWindowDays: Math.round(num(s.skuWindowDays, DEFAULT_SETTINGS.skuWindowDays, 1, 90)),
    maxHoldDays: Math.round(num(s.maxHoldDays, DEFAULT_SETTINGS.maxHoldDays, 1, 30)),
  };
}

// Live actions need BOTH the merchant's switch and an active paid plan.
function isLive(settings, shopData) {
  return settings.mode === "live" && Boolean(shopData && shopData.plan);
}

const DAY_MS = 24 * 60 * 60 * 1000;

function customerEmail(ticket) {
  const c = ticket.customer || {};
  const email = c.email || (c.channels && c.channels.find && (c.channels.find((ch) => ch.type === "email") || {}).address);
  return email ? String(email).trim().toLowerCase() : null;
}

/**
 * Runs one decision cycle for one shop. Returns a summary.
 *
 * deps = {
 *   store:   { listActiveHolds, createHold, updateHold, releaseHold, logDecision,
 *              hasDecision, addSkuSignal, hasSkuSignalForTicket, countSkuSignals },
 *   gorgias: { fetchRecentTickets(), addTag(ticketId, tag) }          (required)
 *   shopify: { findCustomerByEmail(email), latestOrderProducts(customerId),
 *              addTags(gid, tags), removeTags(gid, tags) }           (required)
 *   klaviyo: { setComplaintFlag(email, bool) }                        (optional)
 *   inventoryPlanner: { reorderBySku() -> Map(sku -> {replenishment, oos}) } (optional)
 *   now: Date
 * }
 */
async function runCycle({ shop, shopData, settings: rawSettings, deps }) {
  const settings = normalizeSettings(rawSettings);
  const live = isLive(settings, shopData);
  const mode = live ? "live" : "shadow";
  const now = deps.now || new Date();
  const { store, gorgias, shopify, klaviyo, inventoryPlanner } = deps;
  const summary = { mode, held: 0, released: 0, vip: 0, skuFlags: 0, errors: [] };

  const tickets = await gorgias.fetchRecentTickets();
  const open = tickets.filter((t) => t.status === "open" && !t.spam);

  // Customers with an open complaint right now → the tickets behind it.
  const complaints = new Map();
  for (const t of open) {
    if (!isComplaint(t)) continue;
    const email = customerEmail(t);
    if (!email) continue;
    if (!complaints.has(email)) complaints.set(email, []);
    complaints.get(email).push(t);
  }

  // Shopify lookups are cached per cycle — several rules need them.
  const customerCache = new Map();
  async function customer(email) {
    if (!customerCache.has(email)) {
      customerCache.set(email, shopify.findCustomerByEmail(email).catch((err) => {
        summary.errors.push(`Shopify customer lookup failed: ${err.message}`);
        return null;
      }));
    }
    return customerCache.get(email);
  }

  // A shadow "would apply" must not stop the real action once live.
  const doneStatuses = live ? ["applied"] : ["applied", "would_apply"];

  async function record(entry) {
    await store.logDecision({ shop, mode, createdAt: now, ...entry });
  }

  // ---------- Rules 1 + 2: hold review requests / pause marketing ----------
  const holdRulesOn = settings.rules.holdReviews || settings.rules.pauseMarketing;
  const activeHolds = holdRulesOn ? await store.listActiveHolds(shop) : [];
  const heldEmails = new Set(activeHolds.map((h) => h.customerEmail));

  if (holdRulesOn) {
    // Start holds for new complaints.
    for (const [email, ts] of complaints) {
      if (heldEmails.has(email)) continue;
      const cust = await customer(email);
      const actions = [];
      try {
        if (settings.rules.holdReviews) {
          if (live && cust) await shopify.addTags(cust.id, [TAGS.holdReview]);
          actions.push(cust ? `Shopify customer tagged ${TAGS.holdReview} (Judge.me skips tagged customers)` : "No Shopify customer found for this email — review hold not tagged");
        }
        if ((settings.rules.pauseMarketing || settings.rules.holdReviews) && klaviyo) {
          if (live) await klaviyo.setComplaintFlag(email, true);
          actions.push("Klaviyo profile dp_open_complaint = true");
        }
        await store.createHold({
          shop, customerEmail: email, shopifyCustomerId: cust ? cust.id : null,
          ticketIds: ts.map((t) => t.id), mode, startedAt: now,
        });
        heldEmails.add(email);
        summary.held += 1;
        await record({
          rule: settings.rules.holdReviews ? "holdReviews" : "pauseMarketing",
          status: live ? "applied" : "would_apply",
          customerEmail: email,
          subjectId: String(ts[0].id),
          summary: `Open complaint on ticket #${ts[0].id}: ${ts[0].subject || "(no subject)"}`,
          action: actions.join("; ") || "Hold recorded",
        });
      } catch (err) {
        summary.errors.push(`Hold failed for a customer: ${err.message}`);
        await record({ rule: "holdReviews", status: "failed", customerEmail: email, subjectId: String(ts[0].id),
          summary: `Could not start hold for ticket #${ts[0].id}`, action: err.message });
      }
    }

    // Release holds whose complaint has closed, or that hit the cap.
    for (const hold of activeHolds) {
      const stillOpen = complaints.has(hold.customerEmail);
      const ageDays = (now - new Date(hold.startedAt)) / DAY_MS;
      if (stillOpen && ageDays < settings.maxHoldDays) {
        // Started in shadow, store has since gone live: apply it for real now.
        if (live && hold.mode !== "live") {
          try {
            const cust = hold.shopifyCustomerId ? { id: hold.shopifyCustomerId } : await customer(hold.customerEmail);
            if (settings.rules.holdReviews && cust) await shopify.addTags(cust.id, [TAGS.holdReview]);
            if (klaviyo) await klaviyo.setComplaintFlag(hold.customerEmail, true);
            await store.updateHold({ shop, holdId: hold.id, mode: "live", shopifyCustomerId: cust ? cust.id : null });
            await record({
              rule: "holdReviews", status: "applied", customerEmail: hold.customerEmail,
              subjectId: (hold.ticketIds && hold.ticketIds[0]) ? String(hold.ticketIds[0]) : null,
              summary: "Hold started in shadow mode, now applied live (complaint still open)",
              action: `Shopify customer tagged ${TAGS.holdReview}; Klaviyo dp_open_complaint = true`,
            });
          } catch (err) {
            summary.errors.push(`Could not apply a shadow hold live: ${err.message}`);
          }
        }
        continue;
      }
      const reason = stillOpen ? `held the maximum ${settings.maxHoldDays} days` : "complaint ticket closed";
      try {
        // Undo only what was actually done live for this hold.
        if (hold.mode === "live") {
          if (hold.shopifyCustomerId) await shopify.removeTags(hold.shopifyCustomerId, [TAGS.holdReview]);
          if (klaviyo) await klaviyo.setComplaintFlag(hold.customerEmail, false);
        }
        await store.releaseHold({ shop, holdId: hold.id, releasedAt: now, reason });
        summary.released += 1;
        await record({
          rule: "holdReviews", status: "released", customerEmail: hold.customerEmail,
          subjectId: (hold.ticketIds && hold.ticketIds[0]) ? String(hold.ticketIds[0]) : null,
          summary: `Hold released after ${Math.max(0, ageDays).toFixed(1)} days (${reason})`,
          action: hold.mode === "live" ? "Review-hold tag removed; Klaviyo dp_open_complaint = false" : "Would remove review-hold tag and Klaviyo flag",
        });
      } catch (err) {
        summary.errors.push(`Release failed for a customer: ${err.message}`);
      }
    }
  }

  // ---------- Rule 4: VIP escalation ----------
  if (settings.rules.vipEscalation) {
    for (const t of open) {
      const email = customerEmail(t);
      if (!email) continue;
      if (await store.hasDecision({ shop, rule: "vipEscalation", subjectId: String(t.id), statuses: doneStatuses })) continue;
      const cust = await customer(email);
      if (!cust || !(Number(cust.amountSpent) >= settings.vipThreshold)) continue;
      try {
        if (live) await gorgias.addTag(t.id, TAGS.vip);
        summary.vip += 1;
        await record({
          rule: "vipEscalation", status: live ? "applied" : "would_apply", customerEmail: email,
          subjectId: String(t.id),
          summary: `Ticket #${t.id} from a customer with ${cust.currency || ""}${Number(cust.amountSpent).toFixed(0)} lifetime spend`,
          action: `Gorgias ticket tagged ${TAGS.vip}`,
        });
      } catch (err) {
        summary.errors.push(`VIP tag failed on ticket #${t.id}: ${err.message}`);
      }
    }
  }

  // ---------- Rule 3: product (SKU) flags ----------
  if (settings.rules.skuFlags) {
    const touched = new Map(); // productId -> {title, signal, sku}
    for (const t of tickets) {
      if (t.spam) continue;
      const signal = productSignal(t);
      if (!signal) continue;
      const email = customerEmail(t);
      if (!email) continue;
      // Already counted on an earlier cycle: skip the Shopify lookups.
      if (await store.hasSkuSignalForTicket({ shop, ticketId: String(t.id) })) continue;
      const cust = await customer(email);
      if (!cust) continue;
      let products = [];
      try {
        products = await shopify.latestOrderProducts(cust.id);
      } catch (err) {
        summary.errors.push(`Order lookup failed: ${err.message}`);
        continue;
      }
      // Only attribute a complaint when the latest order has ONE product;
      // with several we can't tell which one the customer means.
      if (products.length !== 1) continue;
      const p = products[0];
      const added = await store.addSkuSignal({ shop, productId: p.productId, ticketId: String(t.id), signal, createdAt: now });
      if (added) touched.set(p.productId, { title: p.title, signal, sku: p.sku });
    }

    let reorder = null;
    for (const [productId, info] of touched) {
      const since = new Date(now - settings.skuWindowDays * DAY_MS);
      const count = await store.countSkuSignals({ shop, productId, signal: info.signal, since });
      if (count < settings.skuFlagMin) continue;
      if (await store.hasDecision({ shop, rule: "skuFlags", subjectId: `${productId}:${info.signal}`, since, statuses: doneStatuses })) continue;
      const tag = info.signal === "sizing" ? TAGS.sizing : TAGS.quality;
      let ipNote = "";
      if (inventoryPlanner && info.sku) {
        try {
          if (!reorder) reorder = await inventoryPlanner.reorderBySku();
          const r = reorder.get(info.sku);
          if (r) ipNote = ` Inventory Planner recommends reordering ${r.replenishment} (sells out in ~${r.oos}d) — check before you reorder.`;
        } catch (err) {
          summary.errors.push(`Inventory Planner lookup failed: ${err.message}`);
        }
      }
      try {
        if (live) await shopify.addTags(productId, [tag]);
        summary.skuFlags += 1;
        await record({
          rule: "skuFlags", status: live ? "applied" : "would_apply", customerEmail: null,
          subjectId: `${productId}:${info.signal}`,
          summary: `${info.title}: ${count} ${info.signal} complaints in ${settings.skuWindowDays} days.${ipNote}`,
          action: `Shopify product tagged ${tag}`,
        });
      } catch (err) {
        summary.errors.push(`Product tag failed: ${err.message}`);
      }
    }
  }

  return summary;
}

module.exports = {
  classifyTicket,
  isComplaint,
  productSignal,
  normalizeSettings,
  isLive,
  runCycle,
  customerEmail,
  DEFAULT_SETTINGS,
  TAGS,
  ESCALATE_KEYWORDS,
  URGENT_KEYWORDS,
  ROUTINE_KEYWORDS,
};
