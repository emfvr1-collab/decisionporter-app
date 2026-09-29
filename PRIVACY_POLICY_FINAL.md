# DecisionPorter — Privacy Policy

**Last updated:** September 28, 2026

## Who we are
DecisionPorter is provided by Decision Porter LLC, a Pennsylvania limited liability company, located at 605 Richmond Drive, P311, Lancaster, PA 17601.

## What we collect
When a store installs DecisionPorter, we collect:
- The store's Shopify domain and access token, so the app can function.
- Once connected, data from the integrations you authorize:
  - **Gorgias:** ticket subjects and summaries, used to classify priority; DecisionPorter writes a tag back to high-confidence tickets.
  - **Klaviyo:** customer profile and churn-risk data, and list membership; DecisionPorter adds at-risk customers to a win-back list you choose.
  - **Inventory Planner:** SKU-level reorder forecasts (read-only).
  - **Judge.me:** review content and ratings (read-only).
- Only the data needed to generate a decision is retained — DecisionPorter does not store full customer records, payment details, or order history beyond what a connected integration provides.

## What we don't do
- We do not sell merchant or customer data.
- We do not use store data to train models beyond what's needed to run the decision it was collected for.

## How long we keep data
Decision logs and connected-integration data are kept for as long as the app remains installed on a store. Uninstalling the app triggers Shopify's mandatory `app/uninstalled` webhook, which deletes the shop's stored data automatically.

## Customer-level requests
This app does not store individual customers' personal data separately from the connected integrations themselves — it stores shop-level connection credentials and the decisions it generates. Requests under Shopify's `customers/data_request` and `customers/redact` webhooks are logged and acknowledged accordingly.

## Your rights
Merchants and their customers can request a copy of, or deletion of, their data by contacting support@decisionporter.com. This app also responds to Shopify's mandatory `customers/data_request`, `customers/redact`, and `shop/redact` webhooks automatically.

## Contact
support@decisionporter.com

---
*This is a starting point, not legal advice. Consider having a lawyer review it before publishing, especially once you're handling real customer data from Gorgias, Klaviyo, Inventory Planner, or Judge.me.*
