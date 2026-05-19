import type { WebhookHandler } from "~/lib/appapprove-config";
import {
  markWebhookSeen,
  recordAction,
  upsertContract,
} from "~/lib/db.server";
import { normaliseShopifyContract } from "~/lib/subscriptions/contract-sync";

const handler: WebhookHandler = async ({ shop, payload, headers, context }) => {
  const webhookId = headers.get("x-shopify-webhook-id") ?? "";
  const nowMs = Date.now();

  // Idempotency: dedup by webhook id (the KV-based dedup already runs
  // before us in webhook-router; this is a defense-in-depth DB dedup
  // so a missing KV binding still gives us at-least-once-with-dedup).
  if (webhookId) {
    const firstTime = await markWebhookSeen(
      context,
      webhookId,
      "subscription_contracts/update",
      shop,
      nowMs,
    ).catch(() => true);
    if (!firstTime) {
      return new Response("OK (duplicate)", { status: 200 });
    }
  }

  const normalised = normaliseShopifyContract(payload as Record<string, unknown>);
  if (!normalised) {
    return new Response("OK (payload missing contract id)", { status: 200 });
  }

  await upsertContract(context, {
    shopifyContractId: normalised.shopifyContractId,
    shop,
    customerId: normalised.customerId,
    customerEmail: normalised.customerEmail,
    status: normalised.status,
    currency: normalised.currency,
    amountCents: normalised.amountCents,
    interval: normalised.interval,
    intervalCount: normalised.intervalCount,
    nextBillingAt: normalised.nextBillingAt,
    cancelledAt: normalised.status === "cancelled" ? nowMs : null,
    lineItems: normalised.lineItems,
    nowMs,
  });

  await recordAction(context, {
    shop,
    shopifyContractId: normalised.shopifyContractId,
    action: normalised.status === "cancelled" ? "cancel" : "created",
    actor: "shopify",
    newState: { status: normalised.status },
    note: "subscription_contracts/update",
    nowMs,
  });

  return new Response("OK", { status: 200 });
};

export default handler;
