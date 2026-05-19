// SubManager data access layer. Thin wrapper around the Cloudflare D1
// binding — no ORM. Every query is a single prepared statement. All
// public functions accept the AppLoadContext so route loaders pass
// through `context` directly.
//
// Conventions:
//   - All timestamps are integer ms-since-epoch.
//   - Currency is always integer cents.
//   - If env.D1 is unbound (e.g. local dev without `wrangler dev
//     --remote`), every query rejects with a descriptive error so the
//     route surfaces a 500 immediately instead of returning silent nulls.
//   - ensureSchema() runs idempotent CREATE TABLE IF NOT EXISTS so the
//     app boots on a fresh D1 even before the wrangler-managed
//     migrations workflow has run. Cheap on subsequent calls.

import type { AppLoadContext } from "@remix-run/cloudflare";
import type { Env } from "../../load-context";
import { ALL_MIGRATIONS } from "./db/migrations";

function envOf(context: AppLoadContext): Env {
  return (context.cloudflare?.env ?? {}) as Env;
}

export function getD1(context: AppLoadContext): D1Database {
  const env = envOf(context);
  if (!env.D1) {
    throw new Error("D1 binding is not configured. Add [[d1_databases]] to wrangler.toml.");
  }
  return env.D1;
}

export function hasD1(context: AppLoadContext): boolean {
  return !!envOf(context).D1;
}

// ─── Schema bootstrap ───────────────────────────────────────────────

let schemaEnsured = false;

export async function ensureSchema(context: AppLoadContext): Promise<void> {
  if (schemaEnsured) return;
  const db = getD1(context);
  for (const m of ALL_MIGRATIONS) {
    // Split on `;` boundaries — D1's `exec` runs multi-statement scripts
    // but rejects empty statements. Statements that contain backticks
    // or `;` inside string literals would need a smarter splitter; our
    // schema doesn't use either.
    const statements = m.sql
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      await db.prepare(stmt).run();
    }
  }
  schemaEnsured = true;
}

// ─── Contracts ──────────────────────────────────────────────────────

export interface ContractRow {
  shopify_contract_id: string;
  shop: string;
  customer_id: string;
  customer_email: string;
  status: "active" | "paused" | "cancelled" | "expired" | "failed";
  currency: string;
  amount_cents: number;
  interval: "day" | "week" | "month" | "year";
  interval_count: number;
  prepaid_cycles: number;
  next_billing_at: number | null;
  paused_until: number | null;
  cancelled_at: number | null;
  line_items_json: string;
  is_gift: number;
  gift_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface UpsertContractInput {
  shopifyContractId: string;
  shop: string;
  customerId: string;
  customerEmail: string;
  status: ContractRow["status"];
  currency: string;
  amountCents: number;
  interval: ContractRow["interval"];
  intervalCount: number;
  prepaidCycles?: number;
  nextBillingAt: number | null;
  pausedUntil?: number | null;
  cancelledAt?: number | null;
  lineItems: unknown[];
  isGift?: boolean;
  giftId?: string | null;
  nowMs: number;
}

export async function upsertContract(
  context: AppLoadContext,
  input: UpsertContractInput,
): Promise<void> {
  await ensureSchema(context);
  const db = getD1(context);
  await db
    .prepare(
      `INSERT INTO subscription_contracts (
         shopify_contract_id, shop, customer_id, customer_email, status,
         currency, amount_cents, interval, interval_count, prepaid_cycles,
         next_billing_at, paused_until, cancelled_at, line_items_json,
         is_gift, gift_id, created_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(shopify_contract_id) DO UPDATE SET
         status = excluded.status,
         currency = excluded.currency,
         amount_cents = excluded.amount_cents,
         interval = excluded.interval,
         interval_count = excluded.interval_count,
         prepaid_cycles = excluded.prepaid_cycles,
         next_billing_at = excluded.next_billing_at,
         paused_until = excluded.paused_until,
         cancelled_at = excluded.cancelled_at,
         line_items_json = excluded.line_items_json,
         is_gift = excluded.is_gift,
         gift_id = excluded.gift_id,
         updated_at = excluded.updated_at`,
    )
    .bind(
      input.shopifyContractId,
      input.shop,
      input.customerId,
      input.customerEmail,
      input.status,
      input.currency,
      input.amountCents,
      input.interval,
      input.intervalCount,
      input.prepaidCycles ?? 0,
      input.nextBillingAt,
      input.pausedUntil ?? null,
      input.cancelledAt ?? null,
      JSON.stringify(input.lineItems),
      input.isGift ? 1 : 0,
      input.giftId ?? null,
      input.nowMs,
      input.nowMs,
    )
    .run();
}

export async function getContract(
  context: AppLoadContext,
  shop: string,
  shopifyContractId: string,
): Promise<ContractRow | null> {
  await ensureSchema(context);
  const db = getD1(context);
  const row = await db
    .prepare(`SELECT * FROM subscription_contracts WHERE shop = ? AND shopify_contract_id = ?`)
    .bind(shop, shopifyContractId)
    .first<ContractRow>();
  return row ?? null;
}

export async function listContractsForCustomer(
  context: AppLoadContext,
  shop: string,
  customerId: string,
): Promise<ContractRow[]> {
  await ensureSchema(context);
  const db = getD1(context);
  const res = await db
    .prepare(
      `SELECT * FROM subscription_contracts
       WHERE shop = ? AND customer_id = ?
       ORDER BY created_at DESC`,
    )
    .bind(shop, customerId)
    .all<ContractRow>();
  return res.results ?? [];
}

export interface ListContractsFilters {
  shop: string;
  status?: ContractRow["status"];
  limit?: number;
  offset?: number;
  sortBy?: "next_billing_at" | "created_at" | "updated_at";
  sortDir?: "asc" | "desc";
}

export async function listContracts(
  context: AppLoadContext,
  filters: ListContractsFilters,
): Promise<{ rows: ContractRow[]; total: number }> {
  await ensureSchema(context);
  const db = getD1(context);
  const where: string[] = ["shop = ?"];
  const params: unknown[] = [filters.shop];
  if (filters.status) {
    where.push("status = ?");
    params.push(filters.status);
  }
  const sortCol = filters.sortBy ?? "next_billing_at";
  const sortDir = filters.sortDir === "asc" ? "ASC" : "DESC";
  const limit = Math.min(filters.limit ?? 25, 100);
  const offset = filters.offset ?? 0;
  const sql = `SELECT * FROM subscription_contracts
               WHERE ${where.join(" AND ")}
               ORDER BY ${sortCol} ${sortDir}
               LIMIT ? OFFSET ?`;
  const res = await db
    .prepare(sql)
    .bind(...params, limit, offset)
    .all<ContractRow>();
  const totalRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM subscription_contracts WHERE ${where.join(" AND ")}`)
    .bind(...params)
    .first<{ n: number }>();
  return { rows: res.results ?? [], total: totalRow?.n ?? 0 };
}

export async function listContractsForRollup(
  context: AppLoadContext,
  shop: string,
): Promise<ContractRow[]> {
  await ensureSchema(context);
  const db = getD1(context);
  const res = await db
    .prepare(`SELECT * FROM subscription_contracts WHERE shop = ?`)
    .bind(shop)
    .all<ContractRow>();
  return res.results ?? [];
}

export async function updateContractStatus(
  context: AppLoadContext,
  input: {
    shop: string;
    shopifyContractId: string;
    status: ContractRow["status"];
    nextBillingAt?: number | null;
    pausedUntil?: number | null;
    cancelledAt?: number | null;
    lineItems?: unknown[];
    intervalCount?: number;
    nowMs: number;
  },
): Promise<void> {
  await ensureSchema(context);
  const db = getD1(context);
  const sets: string[] = ["status = ?", "updated_at = ?"];
  const params: unknown[] = [input.status, input.nowMs];
  if (input.nextBillingAt !== undefined) {
    sets.push("next_billing_at = ?");
    params.push(input.nextBillingAt);
  }
  if (input.pausedUntil !== undefined) {
    sets.push("paused_until = ?");
    params.push(input.pausedUntil);
  }
  if (input.cancelledAt !== undefined) {
    sets.push("cancelled_at = ?");
    params.push(input.cancelledAt);
  }
  if (input.lineItems !== undefined) {
    sets.push("line_items_json = ?");
    params.push(JSON.stringify(input.lineItems));
  }
  if (input.intervalCount !== undefined) {
    sets.push("interval_count = ?");
    params.push(input.intervalCount);
  }
  params.push(input.shop, input.shopifyContractId);
  await db
    .prepare(
      `UPDATE subscription_contracts SET ${sets.join(", ")}
       WHERE shop = ? AND shopify_contract_id = ?`,
    )
    .bind(...params)
    .run();
}

// ─── Audit actions ──────────────────────────────────────────────────

export type ActionType =
  | "created" | "pause" | "skip" | "cancel" | "reactivate"
  | "swap" | "change_frequency" | "dunning" | "renewal_reminder" | "gift_created";

export interface RecordActionInput {
  shop: string;
  shopifyContractId: string;
  action: ActionType;
  actor: "customer" | "merchant" | "system" | "shopify";
  oldState?: unknown;
  newState?: unknown;
  note?: string | null;
  nowMs: number;
}

export async function recordAction(
  context: AppLoadContext,
  input: RecordActionInput,
): Promise<void> {
  await ensureSchema(context);
  const db = getD1(context);
  await db
    .prepare(
      `INSERT INTO subscription_actions (
         shop, shopify_contract_id, action, actor,
         old_state_json, new_state_json, note, created_at
       ) VALUES (?,?,?,?,?,?,?,?)`,
    )
    .bind(
      input.shop,
      input.shopifyContractId,
      input.action,
      input.actor,
      input.oldState === undefined ? null : JSON.stringify(input.oldState),
      input.newState === undefined ? null : JSON.stringify(input.newState),
      input.note ?? null,
      input.nowMs,
    )
    .run();
}

export interface ActionRow {
  id: number;
  shop: string;
  shopify_contract_id: string;
  action: ActionType;
  actor: RecordActionInput["actor"];
  old_state_json: string | null;
  new_state_json: string | null;
  note: string | null;
  created_at: number;
}

export async function listActionsForContract(
  context: AppLoadContext,
  shop: string,
  shopifyContractId: string,
  limit = 50,
): Promise<ActionRow[]> {
  await ensureSchema(context);
  const db = getD1(context);
  const res = await db
    .prepare(
      `SELECT * FROM subscription_actions
       WHERE shop = ? AND shopify_contract_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(shop, shopifyContractId, limit)
    .all<ActionRow>();
  return res.results ?? [];
}

// ─── Dunning ───────────────────────────────────────────────────────

export interface DunningRow {
  id: number;
  shop: string;
  shopify_contract_id: string;
  billing_attempt_id: string | null;
  status: "pending" | "scheduled" | "succeeded" | "failed_terminal";
  attempt_count: number;
  scheduled_for: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export async function getActiveDunning(
  context: AppLoadContext,
  shop: string,
  shopifyContractId: string,
): Promise<DunningRow | null> {
  await ensureSchema(context);
  const db = getD1(context);
  const row = await db
    .prepare(
      `SELECT * FROM dunning_attempts
       WHERE shop = ? AND shopify_contract_id = ? AND status IN ('scheduled','pending')
       ORDER BY id DESC LIMIT 1`,
    )
    .bind(shop, shopifyContractId)
    .first<DunningRow>();
  return row ?? null;
}

export async function upsertDunning(
  context: AppLoadContext,
  input: {
    shop: string;
    shopifyContractId: string;
    billingAttemptId?: string | null;
    status: DunningRow["status"];
    attemptCount: number;
    scheduledFor: number | null;
    lastError: string | null;
    nowMs: number;
  },
): Promise<void> {
  await ensureSchema(context);
  const db = getD1(context);
  // No natural unique key — there can be many historical rows. We
  // update the most recent open row; if none, insert.
  const existing = await getActiveDunning(context, input.shop, input.shopifyContractId);
  if (existing) {
    await db
      .prepare(
        `UPDATE dunning_attempts SET
           billing_attempt_id = COALESCE(?, billing_attempt_id),
           status = ?, attempt_count = ?, scheduled_for = ?, last_error = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        input.billingAttemptId ?? null,
        input.status,
        input.attemptCount,
        input.scheduledFor,
        input.lastError,
        input.nowMs,
        existing.id,
      )
      .run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO dunning_attempts (
         shop, shopify_contract_id, billing_attempt_id, status,
         attempt_count, scheduled_for, last_error, created_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      input.shop,
      input.shopifyContractId,
      input.billingAttemptId ?? null,
      input.status,
      input.attemptCount,
      input.scheduledFor,
      input.lastError,
      input.nowMs,
      input.nowMs,
    )
    .run();
}

export async function listDueDunning(
  context: AppLoadContext,
  nowMs: number,
  limit = 100,
): Promise<DunningRow[]> {
  await ensureSchema(context);
  const db = getD1(context);
  const res = await db
    .prepare(
      `SELECT * FROM dunning_attempts
       WHERE status = 'scheduled' AND scheduled_for IS NOT NULL AND scheduled_for <= ? AND attempt_count < 3
       ORDER BY scheduled_for ASC LIMIT ?`,
    )
    .bind(nowMs, limit)
    .all<DunningRow>();
  return res.results ?? [];
}

export async function listFailedDunningByShop(
  context: AppLoadContext,
  shop: string,
): Promise<DunningRow[]> {
  await ensureSchema(context);
  const db = getD1(context);
  const res = await db
    .prepare(
      `SELECT * FROM dunning_attempts
       WHERE shop = ? AND status = 'scheduled' AND attempt_count >= 3
       ORDER BY updated_at DESC LIMIT 100`,
    )
    .bind(shop)
    .all<DunningRow>();
  return res.results ?? [];
}

// ─── Magic links ───────────────────────────────────────────────────

export interface MagicLinkRow {
  token_sha256: string;
  shop: string;
  customer_id: string;
  customer_email: string;
  expires_at: number;
  used_at: number | null;
  created_at: number;
}

export async function insertMagicLink(
  context: AppLoadContext,
  input: {
    tokenSha256: string;
    shop: string;
    customerId: string;
    customerEmail: string;
    expiresAt: number;
    nowMs: number;
  },
): Promise<void> {
  await ensureSchema(context);
  const db = getD1(context);
  await db
    .prepare(
      `INSERT INTO magic_links (
         token_sha256, shop, customer_id, customer_email, expires_at, used_at, created_at
       ) VALUES (?,?,?,?,?,NULL,?)`,
    )
    .bind(
      input.tokenSha256,
      input.shop,
      input.customerId,
      input.customerEmail,
      input.expiresAt,
      input.nowMs,
    )
    .run();
}

export async function getMagicLink(
  context: AppLoadContext,
  tokenSha256: string,
): Promise<MagicLinkRow | null> {
  await ensureSchema(context);
  const db = getD1(context);
  const row = await db
    .prepare(`SELECT * FROM magic_links WHERE token_sha256 = ?`)
    .bind(tokenSha256)
    .first<MagicLinkRow>();
  return row ?? null;
}

export async function consumeMagicLink(
  context: AppLoadContext,
  tokenSha256: string,
  nowMs: number,
): Promise<number> {
  await ensureSchema(context);
  const db = getD1(context);
  // Single-use: mark used_at atomically only if still unused.
  const res = await db
    .prepare(
      `UPDATE magic_links SET used_at = ?
       WHERE token_sha256 = ? AND used_at IS NULL AND expires_at > ?`,
    )
    .bind(nowMs, tokenSha256, nowMs)
    .run();
  return res.meta?.changes ?? 0;
}

// ─── Renewal reminders ─────────────────────────────────────────────

export interface RenewalReminderRow {
  id: number;
  shop: string;
  shopify_contract_id: string;
  scheduled_for: number;
  sent_at: number | null;
  created_at: number;
}

export async function scheduleRenewalReminder(
  context: AppLoadContext,
  input: {
    shop: string;
    shopifyContractId: string;
    scheduledFor: number;
    nowMs: number;
  },
): Promise<void> {
  await ensureSchema(context);
  const db = getD1(context);
  await db
    .prepare(
      `INSERT INTO renewal_reminders (shop, shopify_contract_id, scheduled_for, created_at)
       VALUES (?,?,?,?)
       ON CONFLICT(shopify_contract_id, scheduled_for) DO NOTHING`,
    )
    .bind(input.shop, input.shopifyContractId, input.scheduledFor, input.nowMs)
    .run();
}

export async function listDueRenewalReminders(
  context: AppLoadContext,
  windowStart: number,
  windowEnd: number,
  limit = 100,
): Promise<RenewalReminderRow[]> {
  await ensureSchema(context);
  const db = getD1(context);
  const res = await db
    .prepare(
      `SELECT * FROM renewal_reminders
       WHERE sent_at IS NULL AND scheduled_for >= ? AND scheduled_for < ?
       ORDER BY scheduled_for ASC LIMIT ?`,
    )
    .bind(windowStart, windowEnd, limit)
    .all<RenewalReminderRow>();
  return res.results ?? [];
}

export async function markRenewalReminderSent(
  context: AppLoadContext,
  id: number,
  nowMs: number,
): Promise<void> {
  await ensureSchema(context);
  const db = getD1(context);
  await db
    .prepare(`UPDATE renewal_reminders SET sent_at = ? WHERE id = ?`)
    .bind(nowMs, id)
    .run();
}

// ─── Settings ──────────────────────────────────────────────────────

export interface AppSettingsRow {
  shop: string;
  dunning_retry_count: number;
  dunning_retry_hours: number;
  renewal_reminder_days: number;
  retention_offer_pct: number;
  billing_day: number;
  enable_prepaid: number;
  enable_gift: number;
  updated_at: number;
}

export const DEFAULT_SETTINGS = {
  dunningRetryCount: 3,
  dunningRetryHours: 24,
  renewalReminderDays: 3,
  retentionOfferPct: 10,
  billingDay: 1,
  enablePrepaid: 1,
  enableGift: 1,
} as const;

export async function getSettings(
  context: AppLoadContext,
  shop: string,
): Promise<AppSettingsRow> {
  await ensureSchema(context);
  const db = getD1(context);
  const row = await db
    .prepare(`SELECT * FROM app_settings WHERE shop = ?`)
    .bind(shop)
    .first<AppSettingsRow>();
  if (row) return row;
  return {
    shop,
    dunning_retry_count: DEFAULT_SETTINGS.dunningRetryCount,
    dunning_retry_hours: DEFAULT_SETTINGS.dunningRetryHours,
    renewal_reminder_days: DEFAULT_SETTINGS.renewalReminderDays,
    retention_offer_pct: DEFAULT_SETTINGS.retentionOfferPct,
    billing_day: DEFAULT_SETTINGS.billingDay,
    enable_prepaid: DEFAULT_SETTINGS.enablePrepaid,
    enable_gift: DEFAULT_SETTINGS.enableGift,
    updated_at: 0,
  };
}

export async function saveSettings(
  context: AppLoadContext,
  shop: string,
  patch: Partial<{
    dunningRetryCount: number;
    dunningRetryHours: number;
    renewalReminderDays: number;
    retentionOfferPct: number;
    billingDay: number;
    enablePrepaid: number;
    enableGift: number;
  }>,
  nowMs: number,
): Promise<void> {
  await ensureSchema(context);
  const db = getD1(context);
  const current = await getSettings(context, shop);
  await db
    .prepare(
      `INSERT INTO app_settings (
         shop, dunning_retry_count, dunning_retry_hours,
         renewal_reminder_days, retention_offer_pct, billing_day,
         enable_prepaid, enable_gift, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(shop) DO UPDATE SET
         dunning_retry_count = excluded.dunning_retry_count,
         dunning_retry_hours = excluded.dunning_retry_hours,
         renewal_reminder_days = excluded.renewal_reminder_days,
         retention_offer_pct = excluded.retention_offer_pct,
         billing_day = excluded.billing_day,
         enable_prepaid = excluded.enable_prepaid,
         enable_gift = excluded.enable_gift,
         updated_at = excluded.updated_at`,
    )
    .bind(
      shop,
      patch.dunningRetryCount ?? current.dunning_retry_count,
      patch.dunningRetryHours ?? current.dunning_retry_hours,
      patch.renewalReminderDays ?? current.renewal_reminder_days,
      patch.retentionOfferPct ?? current.retention_offer_pct,
      patch.billingDay ?? current.billing_day,
      patch.enablePrepaid ?? current.enable_prepaid,
      patch.enableGift ?? current.enable_gift,
      nowMs,
    )
    .run();
}

// ─── Gift subscriptions ────────────────────────────────────────────

export interface GiftRow {
  id: string;
  shop: string;
  buyer_customer_id: string;
  buyer_email: string;
  recipient_email: string;
  recipient_name: string | null;
  recipient_address_json: string;
  cycles_total: number;
  cycles_remaining: number;
  amount_paid_cents: number;
  currency: string;
  recipient_token_sha256: string;
  message: string | null;
  shopify_contract_id: string | null;
  status: "pending_setup" | "active" | "completed" | "cancelled";
  created_at: number;
  updated_at: number;
}

export async function insertGift(
  context: AppLoadContext,
  input: {
    id: string;
    shop: string;
    buyerCustomerId: string;
    buyerEmail: string;
    recipientEmail: string;
    recipientName: string | null;
    recipientAddress: unknown;
    cyclesTotal: number;
    amountPaidCents: number;
    currency: string;
    recipientTokenSha256: string;
    message: string | null;
    nowMs: number;
  },
): Promise<void> {
  await ensureSchema(context);
  const db = getD1(context);
  await db
    .prepare(
      `INSERT INTO gift_subscriptions (
         id, shop, buyer_customer_id, buyer_email,
         recipient_email, recipient_name, recipient_address_json,
         cycles_total, cycles_remaining, amount_paid_cents, currency,
         recipient_token_sha256, message, shopify_contract_id, status,
         created_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,'pending_setup',?,?)`,
    )
    .bind(
      input.id,
      input.shop,
      input.buyerCustomerId,
      input.buyerEmail,
      input.recipientEmail,
      input.recipientName,
      JSON.stringify(input.recipientAddress),
      input.cyclesTotal,
      input.cyclesTotal,
      input.amountPaidCents,
      input.currency,
      input.recipientTokenSha256,
      input.message,
      input.nowMs,
      input.nowMs,
    )
    .run();
}

export async function getGiftByRecipientToken(
  context: AppLoadContext,
  tokenSha256: string,
): Promise<GiftRow | null> {
  await ensureSchema(context);
  const db = getD1(context);
  const row = await db
    .prepare(`SELECT * FROM gift_subscriptions WHERE recipient_token_sha256 = ?`)
    .bind(tokenSha256)
    .first<GiftRow>();
  return row ?? null;
}

export async function getGift(
  context: AppLoadContext,
  shop: string,
  giftId: string,
): Promise<GiftRow | null> {
  await ensureSchema(context);
  const db = getD1(context);
  const row = await db
    .prepare(`SELECT * FROM gift_subscriptions WHERE shop = ? AND id = ?`)
    .bind(shop, giftId)
    .first<GiftRow>();
  return row ?? null;
}

export async function updateGift(
  context: AppLoadContext,
  input: {
    id: string;
    cyclesRemaining?: number;
    status?: GiftRow["status"];
    shopifyContractId?: string;
    nowMs: number;
  },
): Promise<void> {
  await ensureSchema(context);
  const db = getD1(context);
  const sets: string[] = ["updated_at = ?"];
  const params: unknown[] = [input.nowMs];
  if (input.cyclesRemaining !== undefined) {
    sets.push("cycles_remaining = ?");
    params.push(input.cyclesRemaining);
  }
  if (input.status !== undefined) {
    sets.push("status = ?");
    params.push(input.status);
  }
  if (input.shopifyContractId !== undefined) {
    sets.push("shopify_contract_id = ?");
    params.push(input.shopifyContractId);
  }
  params.push(input.id);
  await db
    .prepare(`UPDATE gift_subscriptions SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...params)
    .run();
}

// ─── Webhook dedup ─────────────────────────────────────────────────

export async function markWebhookSeen(
  context: AppLoadContext,
  webhookId: string,
  topic: string,
  shop: string,
  nowMs: number,
): Promise<boolean> {
  await ensureSchema(context);
  const db = getD1(context);
  try {
    await db
      .prepare(
        `INSERT INTO webhook_events_seen (webhook_id, topic, shop, seen_at)
         VALUES (?,?,?,?)`,
      )
      .bind(webhookId, topic, shop, nowMs)
      .run();
    return true; // first-time
  } catch {
    return false; // already seen
  }
}
