// Inline SQL migrations. Worker runtime can't use `?raw` imports for
// SQL files (esbuild bundler has no .sql loader configured), so we keep
// the same DDL twice: once in drizzle/0000_subscriptions.sql (read by
// drizzle-kit + the wrangler d1 migrations workflow at deploy time) and
// once here as a TypeScript string for the runtime fallback executor
// in db.server.ts ensureSchema().
//
// Keep both files in sync. The journal entry in drizzle/meta/_journal.json
// is what drizzle-kit cares about.

export const MIGRATION_0000_SUBSCRIPTIONS = `
CREATE TABLE IF NOT EXISTS subscription_contracts (
  shopify_contract_id TEXT PRIMARY KEY,
  shop TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','paused','cancelled','expired','failed')),
  currency TEXT NOT NULL,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  interval TEXT NOT NULL,
  interval_count INTEGER NOT NULL DEFAULT 1,
  prepaid_cycles INTEGER NOT NULL DEFAULT 0,
  next_billing_at INTEGER,
  paused_until INTEGER,
  cancelled_at INTEGER,
  line_items_json TEXT NOT NULL DEFAULT '[]',
  is_gift INTEGER NOT NULL DEFAULT 0,
  gift_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subscription_contracts_shop ON subscription_contracts(shop);
CREATE INDEX IF NOT EXISTS idx_subscription_contracts_status ON subscription_contracts(shop, status);
CREATE INDEX IF NOT EXISTS idx_subscription_contracts_customer ON subscription_contracts(shop, customer_id);
CREATE INDEX IF NOT EXISTS idx_subscription_contracts_next_billing ON subscription_contracts(shop, next_billing_at);

CREATE TABLE IF NOT EXISTS subscription_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop TEXT NOT NULL,
  shopify_contract_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('created','pause','skip','cancel','reactivate','swap','change_frequency','dunning','renewal_reminder','gift_created')),
  actor TEXT NOT NULL CHECK (actor IN ('customer','merchant','system','shopify')),
  old_state_json TEXT,
  new_state_json TEXT,
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subscription_actions_contract ON subscription_actions(shopify_contract_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subscription_actions_shop ON subscription_actions(shop, created_at DESC);

CREATE TABLE IF NOT EXISTS dunning_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop TEXT NOT NULL,
  shopify_contract_id TEXT NOT NULL,
  billing_attempt_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','scheduled','succeeded','failed_terminal')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  scheduled_for INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dunning_status_scheduled ON dunning_attempts(status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_dunning_contract ON dunning_attempts(shopify_contract_id);

CREATE TABLE IF NOT EXISTS magic_links (
  token_sha256 TEXT PRIMARY KEY,
  shop TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_magic_links_customer ON magic_links(shop, customer_id);
CREATE INDEX IF NOT EXISTS idx_magic_links_expires ON magic_links(expires_at);

CREATE TABLE IF NOT EXISTS renewal_reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop TEXT NOT NULL,
  shopify_contract_id TEXT NOT NULL,
  scheduled_for INTEGER NOT NULL,
  sent_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(shopify_contract_id, scheduled_for)
);

CREATE TABLE IF NOT EXISTS gift_subscriptions (
  id TEXT PRIMARY KEY,
  shop TEXT NOT NULL,
  buyer_customer_id TEXT NOT NULL,
  buyer_email TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  recipient_name TEXT,
  recipient_address_json TEXT NOT NULL,
  cycles_total INTEGER NOT NULL,
  cycles_remaining INTEGER NOT NULL,
  amount_paid_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  recipient_token_sha256 TEXT NOT NULL UNIQUE,
  message TEXT,
  shopify_contract_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending_setup','active','completed','cancelled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gift_subscriptions_shop ON gift_subscriptions(shop, status);
CREATE INDEX IF NOT EXISTS idx_gift_subscriptions_recipient ON gift_subscriptions(recipient_email);

CREATE TABLE IF NOT EXISTS app_settings (
  shop TEXT PRIMARY KEY,
  dunning_retry_count INTEGER NOT NULL DEFAULT 3,
  dunning_retry_hours INTEGER NOT NULL DEFAULT 24,
  renewal_reminder_days INTEGER NOT NULL DEFAULT 3,
  retention_offer_pct INTEGER NOT NULL DEFAULT 10,
  billing_day INTEGER NOT NULL DEFAULT 1,
  enable_prepaid INTEGER NOT NULL DEFAULT 1,
  enable_gift INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_events_seen (
  webhook_id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  shop TEXT NOT NULL,
  seen_at INTEGER NOT NULL
);
`;

export const ALL_MIGRATIONS: ReadonlyArray<{ idx: number; tag: string; sql: string }> = [
  { idx: 0, tag: "0000_subscriptions", sql: MIGRATION_0000_SUBSCRIPTIONS },
];
