import type { WebhookHandler } from "~/lib/appapprove-config";
import {
  getActiveDunning,
  getContract,
  getSettings,
  markWebhookSeen,
  recordAction,
  upsertDunning,
  updateContractStatus,
} from "~/lib/db.server";
import { onBillingFailure } from "~/lib/subscriptions/dunning";

interface BillingAttemptPayload {
  id?: string | number;
  admin_graphql_api_id?: string;
  subscription_contract_id?: string | number;
  error_code?: string;
  error_message?: string;
  next_action_url?: string;
}

const handler: WebhookHandler = async ({ shop, payload, headers, context }) => {
  const webhookId = headers.get("x-shopify-webhook-id") ?? "";
  const nowMs = Date.now();
  if (webhookId) {
    const firstTime = await markWebhookSeen(
      context,
      webhookId,
      "subscription_billing_attempts/failure",
      shop,
      nowMs,
    ).catch(() => true);
    if (!firstTime) return new Response("OK (duplicate)", { status: 200 });
  }

  const p = payload as BillingAttemptPayload;
  const contractId =
    p.subscription_contract_id != null ? String(p.subscription_contract_id) : null;
  if (!contractId) {
    return new Response("OK (no contract id)", { status: 200 });
  }
  const errorMsg = p.error_message ?? p.error_code ?? "billing_attempt_failed";
  const billingAttemptId =
    p.admin_graphql_api_id ?? (p.id != null ? String(p.id) : null);

  const settings = await getSettings(context, shop);
  const prev = await getActiveDunning(context, shop, contractId);
  const prevState = prev
    ? {
        status: prev.status,
        attemptCount: prev.attempt_count,
        scheduledFor: prev.scheduled_for,
        lastError: prev.last_error,
      }
    : null;
  const next = onBillingFailure(prevState, nowMs, errorMsg, {
    maxAttempts: settings.dunning_retry_count,
    retryHours: settings.dunning_retry_hours,
  });

  await upsertDunning(context, {
    shop,
    shopifyContractId: contractId,
    billingAttemptId,
    status: next.status,
    attemptCount: next.attemptCount,
    scheduledFor: next.scheduledFor,
    lastError: next.lastError,
    nowMs,
  });

  // Flip the contract status to 'failed' so the dashboard surfaces it.
  const contract = await getContract(context, shop, contractId);
  if (contract && contract.status !== "cancelled") {
    await updateContractStatus(context, {
      shop,
      shopifyContractId: contractId,
      status: "failed",
      nowMs,
    });
  }

  await recordAction(context, {
    shop,
    shopifyContractId: contractId,
    action: "dunning",
    actor: "shopify",
    newState: { attemptCount: next.attemptCount, status: next.status, error: errorMsg },
    note: "billing_attempts/failure",
    nowMs,
  });

  return new Response("OK", { status: 200 });
};

export default handler;
