import type { CronHandler } from "~/lib/appapprove-config";
import type { Env } from "../../load-context";
import {
  getContract,
  getD1,
  listDueRenewalReminders,
  markRenewalReminderSent,
  recordAction,
  scheduleRenewalReminder,
} from "~/lib/db.server";
import { renderRenewalReminder } from "~/lib/emails/templates";
import { sendSubscriptionEmail } from "~/lib/emails/send";

// Daily 09:00 UTC. Two passes:
//   1. ENQUEUE — for every active contract whose next_billing_at falls
//      between now+3d and now+3d+1h, insert a reminder row (idempotent
//      via UNIQUE(shopify_contract_id, scheduled_for)).
//   2. SEND — for every reminder row whose scheduled_for is in the past
//      and sent_at is null, fire the email + mark sent.
//
// Splitting enqueue/send keeps the cron resumable: a partial run that
// inserts rows but fails to send them still completes on the next tick.

const handler: CronHandler = async ({ context, scheduledAt }) => {
  const nowMs = scheduledAt ?? Date.now();

  await enqueueUpcoming(context, nowMs);

  const due = await listDueRenewalReminders(context, nowMs - 86_400_000, nowMs);
  let sent = 0;
  for (const r of due) {
    try {
      const contract = await getContract(context, r.shop, r.shopify_contract_id);
      if (!contract || contract.status !== "active") {
        await markRenewalReminderSent(context, r.id, nowMs);
        continue;
      }
      const portalUrl = `https://${r.shop}/apps/subscriptions`;
      const email = renderRenewalReminder({
        shopName: r.shop.replace(".myshopify.com", ""),
        customerName: null,
        amountFormatted: formatCents(contract.amount_cents, contract.currency),
        nextBillingFormatted: contract.next_billing_at
          ? new Date(contract.next_billing_at).toISOString().slice(0, 10)
          : "soon",
        portalUrl,
        productSummary: contract.line_items_json,
      });
      const result = await sendSubscriptionEmail(context, {
        to: contract.customer_email,
        subject: email.subject,
        html: email.html,
        text: email.text,
        tags: [{ name: "type", value: "renewal_reminder" }],
      });
      if (result.ok) {
        await markRenewalReminderSent(context, r.id, nowMs);
        sent++;
        await recordAction(context, {
          shop: r.shop,
          shopifyContractId: r.shopify_contract_id,
          action: "renewal_reminder",
          actor: "system",
          note: `renewal_reminder_sent via=${result.via}`,
          nowMs,
        });
      } else {
        console.error(
          `[renewal-reminders] send failed contract=${r.shopify_contract_id}: ${result.error}`,
        );
      }
    } catch (err) {
      console.error(
        `[renewal-reminders] processing error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  console.log(`[renewal-reminders] due=${due.length} sent=${sent}`);
};

async function enqueueUpcoming(
  context: import("@remix-run/cloudflare").AppLoadContext,
  nowMs: number,
): Promise<void> {
  const env = (context.cloudflare?.env ?? {}) as Env;
  if (!env.D1) return;
  const db = getD1(context);
  const windowStart = nowMs + 3 * 86_400_000;
  const windowEnd = windowStart + 3_600_000;
  // Find active contracts whose next_billing_at falls inside the +3d / +3d+1h window.
  const candidates = await db
    .prepare(
      `SELECT shop, shopify_contract_id, next_billing_at
       FROM subscription_contracts
       WHERE status = 'active'
         AND next_billing_at IS NOT NULL
         AND next_billing_at >= ?
         AND next_billing_at < ?`,
    )
    .bind(windowStart, windowEnd)
    .all<{ shop: string; shopify_contract_id: string; next_billing_at: number }>();
  for (const c of candidates.results ?? []) {
    await scheduleRenewalReminder(context, {
      shop: c.shop,
      shopifyContractId: c.shopify_contract_id,
      scheduledFor: nowMs,
      nowMs,
    });
  }
}

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
