import {
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  json,
} from "@remix-run/cloudflare";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Banner,
  BlockStack,
  Card,
  Checkbox,
  FormLayout,
  InlineError,
  Layout,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { useState } from "react";
import { authenticate } from "~/lib/shopify.server";
import { shopifyAdmin } from "~/lib/shopify-api.server";
import type { Env } from "../../load-context";
import {
  SELLING_PLAN_GROUP_CREATE,
  SELLING_PLAN_GROUP_LOOKUP,
  buildSellingPlanGroupInput,
  type SellingPlanGroupCreatePayload,
} from "~/lib/subscriptions/selling-plan";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  return json({ shop: url.searchParams.get("shop") ?? "" });
}

interface ActionData {
  ok: boolean;
  error?: string;
  group?: { id: string; name: string; verified: boolean };
}

export async function action({ request, context }: ActionFunctionArgs): Promise<Response> {
  const form = await request.formData();
  const name = String(form.get("name") ?? "").trim();
  const merchantCode = String(form.get("merchantCode") ?? "").trim();
  const description = String(form.get("description") ?? "").trim();
  const baseInterval = String(form.get("baseInterval") ?? "MONTH") as
    | "DAY"
    | "WEEK"
    | "MONTH"
    | "YEAR";
  const baseIntervalCount = Math.max(
    1,
    Number.parseInt(String(form.get("baseIntervalCount") ?? "1"), 10) || 1,
  );
  const enablePrepaid6mo = String(form.get("enablePrepaid6mo") ?? "") === "on";
  const prepaid6moDiscountPct = Math.min(
    50,
    Math.max(0, Number.parseInt(String(form.get("prepaid6moDiscountPct") ?? "10"), 10) || 10),
  );
  const productIds = String(form.get("productIds") ?? "")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (!name) return json<ActionData>({ ok: false, error: "Name is required" }, { status: 400 });
  if (!merchantCode) return json<ActionData>({ ok: false, error: "Merchant code is required" }, { status: 400 });

  // Auth via App Bridge session token — required for any Admin API call.
  try {
    const { session, shop } = await authenticate.admin(request, context);
    const env = (context.cloudflare?.env ?? {}) as Env;
    const api = shopifyAdmin({ env, session, shop });
    const { input, resources } = buildSellingPlanGroupInput({
      name,
      merchantCode,
      description,
      productIds,
      enablePrepaid6mo,
      prepaid6moDiscountPct,
      baseInterval,
      baseIntervalCount,
    });
    const createRes = await api.graphql<{ sellingPlanGroupCreate: SellingPlanGroupCreatePayload }>(
      SELLING_PLAN_GROUP_CREATE,
      { variables: { input, resources } },
    );
    const errors = createRes.sellingPlanGroupCreate.userErrors;
    if (errors.length > 0) {
      return json<ActionData>(
        { ok: false, error: errors.map((e) => e.message).join("; ") },
        { status: 400 },
      );
    }
    const group = createRes.sellingPlanGroupCreate.sellingPlanGroup;
    if (!group) {
      return json<ActionData>({ ok: false, error: "Create succeeded but no group returned" }, { status: 502 });
    }
    // MANDATE: verify by re-querying.
    let verified = false;
    try {
      const lookup = await api.graphql<{ sellingPlanGroup: { id: string } | null }>(
        SELLING_PLAN_GROUP_LOOKUP,
        { variables: { id: group.id } },
      );
      verified = lookup.sellingPlanGroup?.id === group.id;
    } catch {
      verified = false;
    }
    return json<ActionData>({ ok: true, group: { id: group.id, name: group.name, verified } });
  } catch (err) {
    if (err instanceof Response) {
      return json<ActionData>({ ok: false, error: "Authentication required" }, { status: 401 });
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return json<ActionData>({ ok: false, error: message }, { status: 500 });
  }
}

export default function PlansNew() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [form, setForm] = useState({
    name: "Coffee subscription",
    merchantCode: "coffee-monthly",
    description: "",
    baseInterval: "MONTH" as "DAY" | "WEEK" | "MONTH" | "YEAR",
    baseIntervalCount: "1",
    productIds: "",
    enablePrepaid6mo: false,
    prepaid6moDiscountPct: "10",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const isSubmitting = fetcher.state !== "idle";
  const fetcherData = fetcher.data as ActionData | undefined;
  const submitError =
    fetcherData && !fetcherData.ok ? fetcherData.error : undefined;
  const success =
    fetcherData && fetcherData.ok && fetcherData.group ? fetcherData.group : undefined;

  const submit = () => {
    const next: Record<string, string> = {};
    if (!form.name.trim()) next.name = "Required";
    if (!form.merchantCode.trim()) next.merchantCode = "Required";
    if (!/^\d+$/.test(form.baseIntervalCount))
      next.baseIntervalCount = "Must be a positive integer";
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;
    const fd = new FormData();
    fd.set("name", form.name);
    fd.set("merchantCode", form.merchantCode);
    fd.set("description", form.description);
    fd.set("baseInterval", form.baseInterval);
    fd.set("baseIntervalCount", form.baseIntervalCount);
    fd.set("productIds", form.productIds);
    if (form.enablePrepaid6mo) fd.set("enablePrepaid6mo", "on");
    fd.set("prepaid6moDiscountPct", form.prepaid6moDiscountPct);
    fetcher.submit(fd, { method: "post" });
  };

  return (
    <Page
      title="New selling plan"
      backAction={{
        content: "Plans",
        url: `/app/plans?shop=${encodeURIComponent(data.shop)}`,
      }}
      primaryAction={{
        content: "Create plan",
        loading: isSubmitting,
        disabled: isSubmitting,
        onAction: submit,
      }}
    >
      <Layout>
        <Layout.Section>
          {submitError ? (
            <Banner tone="critical" title="Couldn't create plan">
              <p>{submitError}</p>
            </Banner>
          ) : null}
          {success ? (
            <Banner tone="success" title={`Created ${success.name}`}>
              <p>
                Plan ID: {success.id}
                {success.verified ? " — verified via re-query." : " — verification pending."}
              </p>
            </Banner>
          ) : null}
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Basics</Text>
              <FormLayout>
                <TextField
                  label="Plan group name"
                  value={form.name}
                  onChange={(v) => setForm((p) => ({ ...p, name: v }))}
                  error={errors.name}
                  autoComplete="off"
                  requiredIndicator
                />
                <TextField
                  label="Merchant code"
                  helpText="Internal identifier used in reports."
                  value={form.merchantCode}
                  onChange={(v) => setForm((p) => ({ ...p, merchantCode: v }))}
                  error={errors.merchantCode}
                  autoComplete="off"
                  requiredIndicator
                />
                <TextField
                  label="Description (optional)"
                  value={form.description}
                  onChange={(v) => setForm((p) => ({ ...p, description: v }))}
                  multiline={3}
                  autoComplete="off"
                />
              </FormLayout>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Frequency</Text>
              <FormLayout>
                <FormLayout.Group>
                  <Select
                    label="Interval"
                    value={form.baseInterval}
                    onChange={(v) =>
                      setForm((p) => ({ ...p, baseInterval: v as typeof form.baseInterval }))
                    }
                    options={[
                      { label: "Day", value: "DAY" },
                      { label: "Week", value: "WEEK" },
                      { label: "Month", value: "MONTH" },
                      { label: "Year", value: "YEAR" },
                    ]}
                  />
                  <TextField
                    label="Every N"
                    type="number"
                    value={form.baseIntervalCount}
                    onChange={(v) => setForm((p) => ({ ...p, baseIntervalCount: v }))}
                    error={errors.baseIntervalCount}
                    autoComplete="off"
                    min={1}
                  />
                </FormLayout.Group>
                {errors.baseIntervalCount ? (
                  <InlineError message={errors.baseIntervalCount} fieldID="baseIntervalCount" />
                ) : null}
              </FormLayout>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Prepaid option</Text>
              <FormLayout>
                <Checkbox
                  label="Offer a prepaid 6-month plan with a discount"
                  checked={form.enablePrepaid6mo}
                  onChange={(v) => setForm((p) => ({ ...p, enablePrepaid6mo: v }))}
                />
                <TextField
                  label="Prepaid discount %"
                  type="number"
                  value={form.prepaid6moDiscountPct}
                  onChange={(v) => setForm((p) => ({ ...p, prepaid6moDiscountPct: v }))}
                  disabled={!form.enablePrepaid6mo}
                  autoComplete="off"
                  min={0}
                  max={50}
                />
              </FormLayout>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Products</Text>
              <FormLayout>
                <TextField
                  label="Product GIDs (one per line)"
                  helpText="gid://shopify/Product/123…"
                  value={form.productIds}
                  onChange={(v) => setForm((p) => ({ ...p, productIds: v }))}
                  multiline={4}
                  autoComplete="off"
                />
              </FormLayout>
            </BlockStack>
          </Card>
        </Layout.Section>
        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm">What this does</Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Creates a Shopify SellingPlanGroup with a base recurring plan and (optionally) a
                prepaid 6-month plan. Attaching products lets customers subscribe at checkout.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
