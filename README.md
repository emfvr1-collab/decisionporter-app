# DecisionPorter — Starter App

This is a real, working Shopify app. It's simplified on purpose so it's
easy to follow. Do these steps in order.

## What's already done for you
- The "install this app" flow (OAuth)
- The 4 webhooks Shopify requires before it will even look at your app
- A billing screen with your 3 pricing plans
- A working Gorgias connection: pulls real open tickets, scores each
  one, and tags high-confidence ones back in Gorgias automatically
- A working Klaviyo connection: pulls real customer profiles and
  their churn risk (computed by Klaviyo's own ML model, not ours),
  and adds at-risk customers to a win-back list automatically
- A working Inventory Planner connection: pulls real SKUs Inventory
  Planner already recommends reordering, and surfaces the most
  urgent ones (soonest to sell out) in the decision feed
- A working Judge.me connection: pulls real reviews and flags which
  need a founder reply, which are photo-feature candidates, and
  which look worth a manual spam check — all surfaced in the feed

## How the Gorgias part actually works
1. On the dashboard, enter your Gorgias subdomain, agent email, and
   API key. Find these in Gorgias: **Settings → REST API** — click
   "Generate Password" to get an API key.
2. DecisionPorter checks those credentials against Gorgias before saving them.
3. Click "Sync tickets now" — it pulls your open tickets and runs each
   one through a simple, transparent classifier (keyword-based, not a
   trained model — see the comments in `server.js`).
4. Anything scored 0.85 confidence or higher gets a tag added back in
   Gorgias automatically (`decisionporter-priority` or `decisionporter-routine`).
   Anything below that is left alone for a human to review.

## How the Klaviyo part actually works
1. On the dashboard, enter your Klaviyo private API key (Settings →
   API Keys in Klaviyo) and the ID of the Klaviyo list you want
   at-risk customers added to (a "win-back" list you create in
   Klaviyo first — the list's ID is shown on its page).
2. DecisionPorter checks the key against Klaviyo's `/accounts` endpoint
   before saving it.
3. Click "Check churn risk now" — it pulls your customer profiles
   along with Klaviyo's own predictive churn score for each one.
4. Unlike Gorgias, DecisionPorter isn't inventing this score itself — Klaviyo
   already computes it from real order history. DecisionPorter's whole job
   here is just: is this score above 0.7? If so, add the customer to
   your win-back list automatically.
5. Profiles without enough order history for Klaviyo to have scored
   yet are skipped, not guessed at.

## How the Inventory Planner part actually works
1. On the dashboard, enter your Inventory Planner API key and
   Account ID (found in Inventory Planner: Account → Settings → API
   → Generate key).
2. DecisionPorter checks those credentials with a lightweight request before
   saving them.
3. Click "Check reorder urgency now" — it pulls SKUs Inventory
   Planner already recommends reordering, sorted soonest-to-stock-out
   first, and turns the real forecasted days-to-sell-out into an
   urgency score.
4. Unlike Gorgias and Klaviyo, there's no write-back here — Inventory
   Planner's API does not support pushing product or variant changes
   back in (confirmed directly in their docs). So this integration
   surfaces urgent SKUs in DecisionPorter's own decision feed rather than
   writing a tag or adding to a list. That's actually what the
   original plan called for on this one ("surface in an act-today
   dashboard view"), not a limitation we're working around.

## How the Judge.me part actually works
1. On the dashboard, enter your shop domain (in .myshopify.com
   format) and your Private API Token (found in Judge.me: Settings →
   Integrations → View API tokens).
2. DecisionPorter checks those credentials with a lightweight request before
   saving them.
3. Click "Check reviews now" — it pulls your recent reviews and
   flags each one:
   - Rating 2★ or below → flagged as needing a founder reply (real
     rating data, high confidence)
   - Has published photos → flagged as a feature candidate (real
     field, high confidence)
   - Very short review text → flagged for a manual spam check (a
     simple heuristic, deliberately kept low-confidence, same spirit
     as the Gorgias classifier)
4. Like Inventory Planner, there's no write-back here — Judge.me's
   public docs only document retrieving and creating reviews with
   this kind of API key, not publishing, hiding, or replying to one.
   So this integration surfaces what needs attention rather than
   acting on it automatically.

## What's still not built
All four planned integrations (Gorgias, Klaviyo, Inventory Planner,
Judge.me) are wired in now, and storage has moved from a single JSON
file to real Postgres (see the next section). What's left is real
hosting, finished legal content, and the App Store submission steps.

## How the database part actually works
1. Storage used to be one `shops.json` file. That's gone now — all
   shop data (install tokens, and each integration's credentials)
   lives in Postgres, in `db.js`.
2. You need a `DATABASE_URL` in your `.env` — Render and Railway both
   hand you one automatically when you add their free Postgres addon.
   For local testing, a local Postgres install works the same way.
3. The very first time the app starts, it runs a migration
   automatically (`db.migrate()` in `server.js`) that creates the
   `shops` table if it doesn't already exist — no manual setup step.
4. `saveShop()` is written as a single atomic UPDATE that only
   touches the specific columns being changed (e.g. connecting
   Klaviyo only writes the `klaviyo` column). This matters more than
   it might look: an earlier version read the existing row, merged in
   the new field in application code, then wrote the whole thing back
   — and under a real stress test, two integrations connecting for
   the same shop at nearly the same moment caused one to silently
   overwrite the other 19 times out of 20. The current version was
   re-tested the same way, including all 4 integrations connecting
   at once, with zero failures.
5. To test this yourself: install `pg`, point `DATABASE_URL` at a
   real (even local) Postgres instance, connect two integrations back
   to back, and confirm both show as connected — then kill the server
   process entirely and confirm the data is still there after a fresh
   restart, which a JSON file living in memory-adjacent disk state
   can't meaningfully prove the same way.

---

## Step 1 — Create a free Shopify Partner account
Go to partners.shopify.com and sign up (it's free). This is different
from a regular Shopify store account — it's where you manage apps.

## Step 2 — Create a development store
Inside the Partner Dashboard, click "Stores" → "Add store" → "Development
store." This gives you a free test store to install your app on. Never
use a real, live store to test an unfinished app.

## Step 3 — Register your app
In the Partner Dashboard, click "Apps" → "Create app" → "Create app
manually." Give it a name (e.g. "DecisionPorter"). Shopify will show you an
**API key** and **API secret key** — copy both, you'll need them next.

For "App URL" and "Allowed redirection URL(s)," you'll fill these in
after Step 4, once you know your app's real web address.

## Step 4 — Put this app online
This code needs to live somewhere with a real web address (Shopify can't
talk to files on your own computer). Any of these work and have free
tiers: Render, Railway, or Fly.io. In plain terms:
1. Create a free account on one of those.
2. Connect it to a GitHub repo containing these files (or upload them
   directly, depending on the host).
3. It will give you a public URL like `https://decisionporter-app.onrender.com`.

## Step 5 — Fill in your settings
1. Copy `.env.example` to a new file named `.env`.
2. Paste in the API key and secret from Step 3.
3. Set `APP_URL` to the address you got in Step 4.
4. On your hosting provider's dashboard, set these same values as
   "Environment Variables" (this is how the live version gets them —
   your local `.env` file never gets uploaded).

## Step 6 — Connect the pieces
Back in the Partner Dashboard from Step 3:
- Set "App URL" to your `APP_URL`.
- Set "Allowed redirection URL(s)" to `YOUR_APP_URL/auth/callback`.

## Step 7 — Install it on your test store
Visit:
`YOUR_APP_URL/auth?shop=your-dev-store.myshopify.com`

Approve the install. You should land on the dashboard and see the
connect forms for all four integrations. If you see it, the whole
install flow works.

## Step 8 — Test billing (safe — no real money)
`BILLING_TEST_MODE=true` in your `.env` means Shopify will show you the
real charge-approval screen but never actually bill anyone. Click one
of the 3 plan buttons on the dashboard to try it.

## Step 9 — Before you submit for real
You'll need, at minimum:
- A real privacy policy published at a public URL (edit
  `PRIVACY_POLICY.md` and host it somewhere, e.g. as a page on your
  landing site) — mention that DecisionPorter reads ticket subjects/summaries
  and writes tags back to Gorgias, reads and writes Klaviyo profile
  and list data, reads Inventory Planner SKU forecasts, and reads
  Judge.me review data, since all of that is real data access now
- App Store listing content: name, description, icon (1200×1200px),
  screenshots, and pricing — the landing page copy from earlier is a
  good starting point for the description
- `BILLING_TEST_MODE=false` once you're ready to charge real merchants
- Consider whether the Gorgias and Judge.me heuristic classifiers are
  accurate enough to trust, or whether you want a stronger model
  before real merchants rely on auto-tagging their support queue
- Make sure `DATABASE_URL` is set to your real, permanent Postgres
  instance (not a local one) once you deploy — see "How the database
  part actually works" above

## Step 10 — Submit
In the Partner Dashboard, go to your app → "Distribution" → follow the
listing checklist → submit for review. Review typically takes 2–6
weeks, and Shopify will email you if anything needs fixing.

---

## Running it on your own computer to test
```bash
npm install
cp .env.example .env
# fill in .env with your values, using a tool like ngrok to get a
# temporary public URL for local testing
node server.js
```
