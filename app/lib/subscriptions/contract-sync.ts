// Utility: convert a Shopify subscription-contract webhook payload into
// our subscription_contracts table shape. Webhook payloads vary between
// "subscription_contracts/update" (full contract object) and "billing_attempts/*"
// (sparse — only `subscription_contract_id` + status). We extract the
// stable subset that's safe to upsert from either source.

export interface ShopifyContractPayload {
  id?: string | number;
  admin_graphql_api_id?: string;
  status?: string;
  currency_code?: string;
  customer?: {
    id?: string | number;
    email?: string;
    first_name?: string;
    last_name?: string;
  };
  billing_policy?: {
    interval?: string;
    interval_count?: number;
  };
  delivery_policy?: {
    interval?: string;
    interval_count?: number;
  };
  next_billing_date?: string;
  lines?: Array<{
    title?: string;
    variant_id?: string | number;
    quantity?: number;
    current_price?: { amount?: string };
  }>;
}

export interface NormalisedContract {
  shopifyContractId: string;
  customerId: string;
  customerEmail: string;
  status: "active" | "paused" | "cancelled" | "expired" | "failed";
  currency: string;
  amountCents: number;
  interval: "day" | "week" | "month" | "year";
  intervalCount: number;
  nextBillingAt: number | null;
  lineItems: Array<{
    title: string;
    variantId: string;
    quantity: number;
    pricePerCents: number;
  }>;
}

const STATUS_MAP: Record<string, NormalisedContract["status"]> = {
  active: "active",
  paused: "paused",
  cancelled: "cancelled",
  canceled: "cancelled",
  expired: "expired",
  failed: "failed",
};

const INTERVAL_MAP: Record<string, NormalisedContract["interval"]> = {
  DAY: "day",
  WEEK: "week",
  MONTH: "month",
  YEAR: "year",
  day: "day",
  week: "week",
  month: "month",
  year: "year",
};

export function normaliseShopifyContract(
  payload: ShopifyContractPayload,
): NormalisedContract | null {
  const id = payload.admin_graphql_api_id ?? (payload.id != null ? String(payload.id) : null);
  if (!id) return null;
  const customerId = payload.customer?.id != null ? String(payload.customer.id) : "";
  const customerEmail = payload.customer?.email ?? "";
  const rawStatus = (payload.status ?? "active").toLowerCase();
  const status = STATUS_MAP[rawStatus] ?? "active";
  const currency = payload.currency_code ?? "USD";
  const billingPolicy = payload.billing_policy ?? payload.delivery_policy ?? {};
  const rawInterval = billingPolicy.interval ?? "MONTH";
  const interval = INTERVAL_MAP[rawInterval] ?? "month";
  const intervalCount = billingPolicy.interval_count ?? 1;
  const nextBillingAt = payload.next_billing_date
    ? Date.parse(payload.next_billing_date)
    : null;
  const lineItems = (payload.lines ?? []).map((l) => ({
    title: l.title ?? "",
    variantId: l.variant_id != null ? String(l.variant_id) : "",
    quantity: l.quantity ?? 1,
    pricePerCents: priceToCents(l.current_price?.amount),
  }));
  const amountCents = lineItems.reduce(
    (sum, l) => sum + l.pricePerCents * l.quantity,
    0,
  );
  return {
    shopifyContractId: id,
    customerId,
    customerEmail,
    status,
    currency,
    amountCents,
    interval,
    intervalCount,
    nextBillingAt: Number.isFinite(nextBillingAt) ? nextBillingAt : null,
    lineItems,
  };
}

function priceToCents(amount: string | undefined): number {
  if (!amount) return 0;
  const n = Number.parseFloat(amount);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

export function summariseLines(items: NormalisedContract["lineItems"]): string {
  if (items.length === 0) return "—";
  return items
    .map((l) => `${l.title} × ${l.quantity}`)
    .join(", ");
}
