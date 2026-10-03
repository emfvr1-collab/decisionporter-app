/**
 * clients.js — the API calls the decision engine makes
 * -----------------------------------------------------------------
 * Each factory returns the small interface engine.js expects. `fetch`
 * is passed in so tests can supply a fake one.
 *
 * Verified against each vendor's docs on 2026-10-02:
 *  - Shopify expiring offline tokens: access token lasts ~1 hour; refresh
 *    by POSTing grant_type=refresh_token (form-encoded) to
 *    https://{shop}/admin/oauth/access_token. Every refresh returns a NEW
 *    refresh token, which must be saved immediately.
 *  - Shopify GraphQL: customers(query:"email:..."), customer.orders,
 *    tagsAdd / tagsRemove (work on customers and products).
 *  - Klaviyo: GET /api/profiles?filter=equals(email,"...") then
 *    PATCH /api/profiles/{id} — only the properties sent are changed.
 *    We PATCH an existing profile rather than using profile-import so
 *    DecisionPorter never creates new (billable) Klaviyo profiles.
 *  - Judge.me: "blacklist" customers by Shopify tag → review requests
 *    are not sent while the tag is present (merchant enables this in
 *    Judge.me with the tag dp-hold-review).
 * -----------------------------------------------------------------
 */

const ORDER_LOOKBACK_DAYS = 60; // read_orders only covers the last 60 days

// ---------- Shopify ----------

// Returns a function getToken(shop) that refreshes the expiring
// offline token ~60s before it lapses. One refresh at a time per shop:
// Shopify invalidates the old refresh token when a new one is issued,
// so two parallel refreshes would lock the shop out.
function makeTokenManager({ db, fetch, apiKey, apiSecret }) {
  const inFlight = new Map();

  async function refresh(shop, refreshToken) {
    const body = new URLSearchParams({
      client_id: apiKey,
      client_secret: apiSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      throw new Error(`Shopify token refresh failed (${res.status}${data.error ? `: ${data.error}` : ""}) — the merchant may need to reopen the app`);
    }
    await db.saveShop(shop, {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      tokenExpiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : null,
    });
    return data.access_token;
  }

  return async function getToken(shop) {
    const shopData = await db.getShop(shop);
    if (!shopData || !shopData.accessToken) throw new Error("Shop not installed");
    const expiresAt = shopData.tokenExpiresAt ? new Date(shopData.tokenExpiresAt).getTime() : null;
    // Non-expiring token (older installs) or plenty of time left.
    if (!expiresAt || expiresAt - Date.now() > 60 * 1000) return shopData.accessToken;
    if (!shopData.refreshToken) throw new Error("Shopify token expired and no refresh token is stored — reinstall the app");
    if (!inFlight.has(shop)) {
      inFlight.set(shop, refresh(shop, shopData.refreshToken).finally(() => inFlight.delete(shop)));
    }
    return inFlight.get(shop);
  };
}

function makeShopifyClient({ shop, getToken, fetch, apiVersion }) {
  async function gql(query, variables) {
    const token = await getToken(shop);
    const res = await fetch(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`Shopify returned ${res.status}`);
    const data = await res.json();
    if (data.errors) throw new Error(data.errors.map((e) => e.message).join("; "));
    return data.data;
  }

  function checkUserErrors(payload) {
    const errs = payload && payload.userErrors;
    if (errs && errs.length) throw new Error(errs.map((e) => e.message).join("; "));
  }

  return {
    gql,
    async findCustomerByEmail(email) {
      const clean = String(email).replace(/["\\]/g, "");
      const data = await gql(
        `query FindCustomer($q: String!) {
          customers(first: 1, query: $q) { nodes { id amountSpent { amount currencyCode } } }
        }`,
        { q: `email:"${clean}"` }
      );
      const node = data.customers && data.customers.nodes && data.customers.nodes[0];
      if (!node) return null;
      return {
        id: node.id,
        amountSpent: node.amountSpent ? Number(node.amountSpent.amount) : 0,
        currency: node.amountSpent ? `${node.amountSpent.currencyCode} ` : "",
      };
    },
    async latestOrderProducts(customerId) {
      const data = await gql(
        `query LatestOrder($id: ID!) {
          customer(id: $id) {
            orders(first: 1, sortKey: CREATED_AT, reverse: true) {
              nodes { createdAt lineItems(first: 10) { nodes { sku product { id title } } } }
            }
          }
        }`,
        { id: customerId }
      );
      const order = data.customer && data.customer.orders.nodes[0];
      if (!order) return [];
      if (Date.now() - new Date(order.createdAt).getTime() > ORDER_LOOKBACK_DAYS * 864e5) return [];
      const byProduct = new Map();
      for (const li of order.lineItems.nodes) {
        if (!li.product) continue; // deleted product or custom line item
        if (!byProduct.has(li.product.id)) byProduct.set(li.product.id, { productId: li.product.id, title: li.product.title, sku: li.sku || null });
      }
      return [...byProduct.values()];
    },
    async addTags(id, tags) {
      const data = await gql(
        `mutation AddTags($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { field message } } }`,
        { id, tags }
      );
      checkUserErrors(data.tagsAdd);
    },
    async removeTags(id, tags) {
      const data = await gql(
        `mutation RemoveTags($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { field message } } }`,
        { id, tags }
      );
      checkUserErrors(data.tagsRemove);
    },
  };
}

// ---------- Gorgias ----------
function makeGorgiasClient({ config, fetch }) {
  const auth = `Basic ${Buffer.from(`${config.email}:${config.apiKey}`).toString("base64")}`;
  const base = `https://${config.subdomain}.gorgias.com/api`;
  return {
    // Most recently updated tickets, open AND closed — closed ones are
    // how the engine knows a complaint is resolved and a hold can lift.
    async fetchRecentTickets() {
      const res = await fetch(`${base}/tickets?limit=100&order_by=updated_datetime:desc`, { headers: { Authorization: auth } });
      if (!res.ok) throw new Error(`Gorgias returned ${res.status}`);
      const data = await res.json();
      return data.data || data || [];
    },
    async addTag(ticketId, tag) {
      const res = await fetch(`${base}/tickets/${ticketId}/tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: auth },
        body: JSON.stringify({ names: [tag] }),
      });
      if (!res.ok) throw new Error(`Gorgias returned ${res.status} adding a tag`);
    },
  };
}

// ---------- Klaviyo ----------
const KLAVIYO_REVISION = "2026-04-15";

function makeKlaviyoClient({ config, fetch }) {
  const headers = (extra = {}) => ({
    Authorization: `Klaviyo-API-Key ${config.apiKey}`,
    revision: KLAVIYO_REVISION,
    accept: "application/json",
    ...extra,
  });
  return {
    // Sets dp_open_complaint on an EXISTING profile. Customers not in
    // Klaviyo are skipped — we never create profiles.
    async setComplaintFlag(email, value) {
      const filter = encodeURIComponent(`equals(email,"${String(email).replace(/["\\]/g, "")}")`);
      const found = await fetch(`https://a.klaviyo.com/api/profiles?filter=${filter}`, { headers: headers() });
      if (!found.ok) throw new Error(`Klaviyo returned ${found.status} looking up a profile`);
      const list = (await found.json()).data || [];
      if (!list.length) return false;
      const id = list[0].id;
      const res = await fetch(`https://a.klaviyo.com/api/profiles/${id}`, {
        method: "PATCH",
        headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify({
          data: {
            type: "profile",
            id,
            attributes: { properties: { dp_open_complaint: Boolean(value), dp_complaint_updated_at: new Date().toISOString() } },
          },
        }),
      });
      if (!res.ok) throw new Error(`Klaviyo returned ${res.status} updating a profile — the API key needs profiles:write`);
      return true;
    },
  };
}

// ---------- Inventory Planner (read only) ----------
function makeInventoryPlannerClient({ config, fetch }) {
  return {
    async reorderBySku() {
      const url = "https://app.inventory-planner.com/api/v1/variants?fields=id,sku,title,replenishment,oos&replenishment_gt=0&oos_sort=asc&limit=100";
      const res = await fetch(url, { headers: { Authorization: config.apiKey, Account: config.accountId, accept: "application/json" } });
      if (!res.ok) throw new Error(`Inventory Planner returned ${res.status}`);
      const data = await res.json();
      const map = new Map();
      for (const v of data.variants || []) if (v.sku) map.set(v.sku, { replenishment: v.replenishment, oos: v.oos });
      return map;
    },
  };
}

module.exports = {
  makeTokenManager,
  makeShopifyClient,
  makeGorgiasClient,
  makeKlaviyoClient,
  makeInventoryPlannerClient,
};
