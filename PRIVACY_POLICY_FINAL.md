# DecisionPorter — Privacy Policy

**Last updated:** October 2, 2026

## Who we are
DecisionPorter is provided by Decision Porter LLC, a Pennsylvania limited liability company, located at 605 Richmond Drive, P311, Lancaster, PA 17601.

## What we collect
When a store installs DecisionPorter, we collect:
- The store's Shopify domain and access tokens, so the app can function.
- **Shopify customer and order data:** for customers who have an open support ticket, DecisionPorter looks up the customer by email, their lifetime spend, and the products in their most recent order. It adds or removes the tag `dp-hold-review` on the customer and the tags `dp-sizing-watch` or `dp-quality-watch` on products.
- Once connected, data from the integrations you authorize:
  - **Gorgias:** ticket subjects, summaries, status and the customer's email, used to detect complaints and classify priority; DecisionPorter writes tags back to tickets (including `decisionporter-vip`).
  - **Klaviyo:** customer profile and churn-risk data, and list membership; DecisionPorter adds at-risk customers to a win-back list you choose and sets the profile property `dp_open_complaint` while a customer has an open complaint.
  - **Inventory Planner:** SKU-level reorder forecasts (read-only).
  - **Judge.me:** review content and ratings (read-only).
- Only the data needed to generate a decision is retained — DecisionPorter does not store full customer records, payment details, or order history beyond what a connected integration provides.

## What we don't do
- We do not sell merchant or customer data.
- We do not use store data to train models beyond what's needed to run the decision it was collected for.

## How long we keep data
- Decision-log entries, released holds and product-complaint counts are deleted automatically after 90 days.
- A record of who accessed personal data (which Shopify staff account, when, and what action) is kept for 365 days, then deleted.
- Connected-integration credentials are kept while the app is installed. Uninstalling the app triggers Shopify's `app/uninstalled` webhook, which deletes all of the shop's stored data.

## What DecisionPorter stores about customers
DecisionPorter keeps a decision log and a list of active holds. These contain the customer's email address, the related support ticket number and subject, and the action taken. It does not store payment details, addresses or full order histories. Product complaint counts are stored by ticket number and product only.

## Customer-level requests
When Shopify sends a `customers/redact` request, DecisionPorter deletes every decision-log entry and hold that contains that customer's email. A `customers/data_request` is answered by identifying the entries held for that customer so the merchant can provide them.

## Your rights
Merchants and their customers can request a copy of, or deletion of, their data by contacting support@decisionporter.com. This app also responds to Shopify's mandatory `customers/data_request`, `customers/redact`, and `shop/redact` webhooks automatically.

## Contact
support@decisionporter.com

---
*This is a starting point, not legal advice. Consider having a lawyer review it before publishing, especially once you're handling real customer data from Gorgias, Klaviyo, Inventory Planner, or Judge.me.*
