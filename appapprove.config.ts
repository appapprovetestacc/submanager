// AppApprove project configuration. Edit webhook routes, build hooks, and
// environment variable mappings here. The pricing schema lives separately
// in pricing.yaml.
//
// Full reference: https://appapprove.com/docs/config

import type { AppApproveConfig } from "./app/lib/appapprove-config";

const config: AppApproveConfig = {
  slug: "submanager",
  framework: "remix-cloudflare-workers",
  webhooks: {
    // Map Shopify topics to handler modules. AppApprove's webhook router
    // verifies HMAC and dispatches the parsed payload to your handler.
    "customers/data_request": "~/webhooks/customers-data-request",
    "customers/redact": "~/webhooks/customers-redact",
    "shop/redact": "~/webhooks/shop-redact",
    "app_subscriptions/update": "~/webhooks/app-subscriptions-update",
    "subscription_billing_attempts/success":
      "~/webhooks/subscription-billing-attempts-success",
    "subscription_billing_attempts/failure":
      "~/webhooks/subscription-billing-attempts-failure",
    "subscription_contracts/update":
      "~/webhooks/subscription-contracts-update",
  },
  crons: {
    "0 8 * * *": "~/crons/gdpr-deadline-check",
    "0 2 * * *": "~/crons/dunning-retry",
    "0 9 * * *": "~/crons/renewal-reminders",
  },
  env: {
    // Public env vars are exposed to the browser. Secrets stay server-only.
    public: [],
    secrets: ["SHOPIFY_API_SECRET"],
  },
  pricing: "./pricing.yaml",
};

export default config;
