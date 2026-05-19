import type { CronHandler } from "~/lib/appapprove-config";
import {
  getContract,
  getSettings,
  listDueDunning,
  recordAction,
} from "~/lib/db.server";
import { renderDunning } from "~/lib/emails/templates";
import { sendSubscriptionEmail } from "~/lib/emails/send";

// Daily 02:00 UTC: scan dunning_attempts where status='scheduled' AND
// scheduled_for <= now, fire the corresponding retry-attempt email
// (attempt 1/2/3 → numbered template, max → "final"). We do NOT call
// the Shopify retry mutation here — Shopify auto-retries on its own
// schedule; our job is just to keep the customer in the loop and to
// surface "needs attention" rows to the merchant dashboard.

const handler: CronHandler = async ({ context, scheduledAt }) => {
  const nowMs = scheduledAt ?? Date.now();
  const due = await listDueDunning(context, nowMs);
  let sent = 0;
  for (const row of due) {
    try {
      const contract = await getContract(context, row.shop, row.shopify_contract_id);
      if (!contract) continue;
      const settings = await getSettings(context, row.shop);
      const attempt: 1 | 2 | 3 | "final" = (() => {
        if (row.attempt_count >= settings.dunning_retry_count) return "final";
        if (row.attempt_count === 1) return 1;
        if (row.attempt_count === 2) return 2;
        return 3;
      })();
      const amount = formatCents(contract.amount_cents, contract.currency);
      const nextBilling = contract.next_billing_at
        ? new Date(contract.next_billing_at).toISOString().slice(0, 10)
        : "soon";
      const portalUrl = `https://${row.shop}/apps/subscriptions`;
      const email = renderDunning(
        {
          shopName: row.shop.replace(".myshopify.com", ""),
          customerName: null,
          amountFormatted: amount,
          nextBillingFormatted: nextBilling,
          portalUrl,
          productSummary: contract.line_items_json,
        },
        attempt,
      );
      const result = await sendSubscriptionEmail(context, {
        to: contract.customer_email,
        subject: email.subject,
        html: email.html,
        text: email.text,
        tags: [
          { name: "type", value: "dunning" },
          { name: "attempt", value: String(attempt) },
        ],
      });
      if (result.ok) sent++;
      await recordAction(context, {
        shop: row.shop,
        shopifyContractId: row.shopify_contract_id,
        action: "dunning",
        actor: "system",
        note: `dunning_retry_email attempt=${attempt} via=${result.via}`,
        nowMs,
      });
    } catch (err) {
      console.error(
        `[dunning-retry] failed for ${row.shopify_contract_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  console.log(`[dunning-retry] scanned=${due.length} sent=${sent}`);
};

function formatCents(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
      cents / 100,
    );
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

export default handler;
