// Selling-plan-group creation via Shopify Admin GraphQL.
// Builds the input for `sellingPlanGroupCreate` mutation.

export interface SellingPlanWizardInput {
  /** Display name on the storefront, e.g. "Coffee subscription". */
  name: string;
  /** Merchant-facing internal code, e.g. "coffee-monthly". */
  merchantCode: string;
  /** Plan options surfaced to the storefront block as variant choices. */
  description?: string;
  /** Product GIDs to attach this group to (gid://shopify/Product/...). */
  productIds: string[];
  /** Whether to also offer a prepaid 6-month plan with a discount. */
  enablePrepaid6mo: boolean;
  /** Discount percentage applied to the prepaid 6-month plan (1–50). */
  prepaid6moDiscountPct: number;
  /** Base subscription frequency (e.g. interval=MONTH, intervalCount=1). */
  baseInterval: "DAY" | "WEEK" | "MONTH" | "YEAR";
  baseIntervalCount: number;
}

export interface SellingPlanGroupCreatePayload {
  sellingPlanGroup: { id: string; name: string } | null;
  userErrors: Array<{ field: string[]; message: string }>;
}

export const SELLING_PLAN_GROUP_CREATE = `#graphql
mutation SellingPlanGroupCreate($input: SellingPlanGroupInput!, $resources: SellingPlanGroupResourceInput) {
  sellingPlanGroupCreate(input: $input, resources: $resources) {
    sellingPlanGroup { id name }
    userErrors { field message }
  }
}`;

export function buildSellingPlanGroupInput(
  w: SellingPlanWizardInput,
): { input: Record<string, unknown>; resources: { productIds: string[] } | undefined } {
  const sellingPlansToCreate: Array<Record<string, unknown>> = [
    {
      name: `Every ${w.baseIntervalCount} ${w.baseInterval.toLowerCase()}${w.baseIntervalCount > 1 ? "s" : ""}`,
      options: [`Every ${w.baseIntervalCount} ${w.baseInterval.toLowerCase()}${w.baseIntervalCount > 1 ? "s" : ""}`],
      billingPolicy: {
        recurring: {
          interval: w.baseInterval,
          intervalCount: w.baseIntervalCount,
        },
      },
      deliveryPolicy: {
        recurring: {
          interval: w.baseInterval,
          intervalCount: w.baseIntervalCount,
        },
      },
      pricingPolicies: [],
    },
  ];

  if (w.enablePrepaid6mo) {
    const pct = clamp(w.prepaid6moDiscountPct, 0, 50);
    sellingPlansToCreate.push({
      name: `Prepaid 6 months (${pct}% off)`,
      options: [`Prepaid 6 months (${pct}% off)`],
      billingPolicy: {
        recurring: { interval: "MONTH", intervalCount: 6 },
      },
      deliveryPolicy: {
        recurring: { interval: "MONTH", intervalCount: 1, preAnchorBehavior: "ASAP" },
      },
      pricingPolicies: [
        {
          fixed: {
            adjustmentType: "PERCENTAGE",
            adjustmentValue: { percentage: pct },
          },
        },
      ],
    });
  }

  const input: Record<string, unknown> = {
    name: w.name,
    merchantCode: w.merchantCode,
    options: ["Frequency"],
    sellingPlansToCreate,
    ...(w.description ? { description: w.description } : {}),
  };
  const resources = w.productIds.length > 0 ? { productIds: w.productIds } : undefined;
  return { input, resources };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export const SELLING_PLAN_GROUP_LOOKUP = `#graphql
query SellingPlanGroup($id: ID!) {
  sellingPlanGroup(id: $id) {
    id
    name
    merchantCode
    sellingPlans(first: 5) {
      edges { node { id name } }
    }
  }
}`;
