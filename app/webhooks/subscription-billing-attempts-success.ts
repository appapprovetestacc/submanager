import type { WebhookHandler } from "~/lib/appapprove-config";
import {
  getActiveDunning,
  getContract,
  getGift,
  markWebhookSeen,
  recordAction,
  updateContractStatus,
  updateGift,
  upsertDunning,
} from "~/lib/db.server";
import { onBillingSuccess } from "~/lib/subscriptions/dunning";
import { consumeCycle } from "~/lib/subscriptions/gift";

interface BillingAttemptPayload {
  id?: string | number;
  admin_graphql_api_id?: string;
  subscription_contract_id?: string | number;
}

const handler: WebhookHandler = async ({ shop, payload, headers, context }) => {
  const webhookId = headers.get("x-shopify-webhook-id") ?? "";
  const nowMs = Date.now();
  if (webhookId) {
    const firstTime = await markWebhookSeen(
      context,
      webhookId,
      "subscription_billing_attempts/success",
      shop,
      nowMs,
    ).catch(() => true);
    if (!firstTime) return new Response("OK (duplicate)", { status: 200 });
  }

  const p = payload as BillingAttemptPayload;
  const contractId =
    p.subscription_contract_id != null ? String(p.subscription_contract_id) : null;
  if (!contractId) return new Response("OK (no contract id)", { status: 200 });

  // Close any open dunning row.
  const prev = await getActiveDunning(context, shop, contractId);
  if (prev) {
    const next = onBillingSuccess({
      status: prev.status,
      attemptCount: prev.attempt_count,
      scheduledFor: prev.scheduled_for,
      lastError: prev.last_error,
    });
    await upsertDunning(context, {
      shop,
      shopifyContractId: contractId,
      billingAttemptId: prev.billing_attempt_id,
      status: next.status,
      attemptCount: next.attemptCount,
      scheduledFor: next.scheduledFor,
      lastError: next.lastError,
      nowMs,
    });
  }

  // Restore status to active if it was previously failed.
  const contract = await getContract(context, shop, contractId);
  if (contract && contract.status === "failed") {
    await updateContractStatus(context, {
      shop,
      shopifyContractId: contractId,
      status: "active",
      nowMs,
    });
  }

  // Gift cycle countdown: each successful billing consumes one cycle.
  if (contract?.is_gift && contract.gift_id) {
    const gift = await getGift(context, shop, contract.gift_id);
    if (gift && gift.status === "active") {
      const result = consumeCycle({
        cyclesTotal: gift.cycles_total,
        cyclesRemaining: gift.cycles_remaining,
        status: gift.status,
      });
      await updateGift(context, {
        id: gift.id,
        cyclesRemaining: result.next.cyclesRemaining,
        status: result.next.status,
        nowMs,
      });
      if (result.shouldCancelContract) {
        await updateContractStatus(context, {
          shop,
          shopifyContractId: contractId,
          status: "expired",
          cancelledAt: nowMs,
          nowMs,
        });
        await recordAction(context, {
          shop,
          shopifyContractId: contractId,
          action: "cancel",
          actor: "system",
          note: "gift_cycles_completed",
          nowMs,
        });
      }
    }
  }

  await recordAction(context, {
    shop,
    shopifyContractId: contractId,
    action: "renewal_reminder",
    actor: "shopify",
    note: "billing_attempts/success",
    nowMs,
  });

  return new Response("OK", { status: 200 });
};

export default handler;
