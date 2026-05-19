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
  Layout,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { useEffect, useMemo, useRef, useState } from "react";
import { getSettings, saveSettings } from "~/lib/db.server";

export async function loader({ request, context }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") ?? "";
  if (!shop) return json({ shop, settings: null });
  const settings = await getSettings(context, shop);
  return json({ shop, settings });
}

export async function action({ request, context }: ActionFunctionArgs) {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") ?? "";
  if (!shop) return json({ ok: false, error: "missing shop" }, { status: 400 });
  const form = await request.formData();
  const num = (k: string, fb: number) => {
    const n = Number.parseInt(String(form.get(k) ?? ""), 10);
    return Number.isFinite(n) ? n : fb;
  };
  const bool = (k: string) => (String(form.get(k) ?? "") === "on" ? 1 : 0);

  const dunningRetryCount = Math.min(10, Math.max(1, num("dunningRetryCount", 3)));
  const dunningRetryHours = Math.min(168, Math.max(1, num("dunningRetryHours", 24)));
  const renewalReminderDays = Math.min(14, Math.max(1, num("renewalReminderDays", 3)));
  const retentionOfferPct = Math.min(50, Math.max(0, num("retentionOfferPct", 10)));
  const billingDay = Math.min(28, Math.max(1, num("billingDay", 1)));
  await saveSettings(
    context,
    shop,
    {
      dunningRetryCount,
      dunningRetryHours,
      renewalReminderDays,
      retentionOfferPct,
      billingDay,
      enablePrepaid: bool("enablePrepaid"),
      enableGift: bool("enableGift"),
    },
    Date.now(),
  );
  return json({ ok: true });
}

interface FormState {
  dunningRetryCount: string;
  dunningRetryHours: string;
  renewalReminderDays: string;
  retentionOfferPct: string;
  billingDay: string;
  enablePrepaid: boolean;
  enableGift: boolean;
}

export default function SettingsRoute() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const initial: FormState = useMemo(() => ({
    dunningRetryCount: String(data.settings?.dunning_retry_count ?? 3),
    dunningRetryHours: String(data.settings?.dunning_retry_hours ?? 24),
    renewalReminderDays: String(data.settings?.renewal_reminder_days ?? 3),
    retentionOfferPct: String(data.settings?.retention_offer_pct ?? 10),
    billingDay: String(data.settings?.billing_day ?? 1),
    enablePrepaid: (data.settings?.enable_prepaid ?? 1) === 1,
    enableGift: (data.settings?.enable_gift ?? 1) === 1,
  }), [data.settings]);

  const [form, setForm] = useState<FormState>(initial);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const initialRef = useRef(initial);
  const isDirty = JSON.stringify(form) !== JSON.stringify(initialRef.current);
  const isSubmitting = fetcher.state !== "idle";

  const fetcherData = fetcher.data as
    | { ok: true }
    | { ok: false; error?: string }
    | undefined;
  useEffect(() => {
    if (fetcherData && fetcherData.ok) {
      initialRef.current = form;
    }
  }, [fetcherData, form]);

  const validate = (next: FormState): Partial<Record<keyof FormState, string>> => {
    const e: Partial<Record<keyof FormState, string>> = {};
    const n = (s: string) => Number.parseInt(s, 10);
    if (!(n(next.dunningRetryCount) >= 1 && n(next.dunningRetryCount) <= 10))
      e.dunningRetryCount = "Between 1 and 10";
    if (!(n(next.dunningRetryHours) >= 1 && n(next.dunningRetryHours) <= 168))
      e.dunningRetryHours = "Between 1 and 168 hours";
    if (!(n(next.renewalReminderDays) >= 1 && n(next.renewalReminderDays) <= 14))
      e.renewalReminderDays = "Between 1 and 14 days";
    if (!(n(next.retentionOfferPct) >= 0 && n(next.retentionOfferPct) <= 50))
      e.retentionOfferPct = "Between 0 and 50%";
    if (!(n(next.billingDay) >= 1 && n(next.billingDay) <= 28))
      e.billingDay = "Between 1 and 28";
    return e;
  };

  const save = () => {
    const next = validate(form);
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;
    const fd = new FormData();
    fd.set("dunningRetryCount", form.dunningRetryCount);
    fd.set("dunningRetryHours", form.dunningRetryHours);
    fd.set("renewalReminderDays", form.renewalReminderDays);
    fd.set("retentionOfferPct", form.retentionOfferPct);
    fd.set("billingDay", form.billingDay);
    if (form.enablePrepaid) fd.set("enablePrepaid", "on");
    if (form.enableGift) fd.set("enableGift", "on");
    fetcher.submit(fd, { method: "post" });
  };

  return (
    <Page
      title="Settings"
      backAction={{
        content: "Subscriptions",
        url: `/app/subscriptions?shop=${encodeURIComponent(data.shop)}`,
      }}
      primaryAction={{
        content: "Save",
        loading: isSubmitting,
        disabled: isSubmitting || !isDirty,
        onAction: save,
      }}
      secondaryActions={[
        {
          content: "Discard",
          disabled: !isDirty || isSubmitting,
          onAction: () => setForm(initialRef.current),
        },
      ]}
    >
      <Layout>
        <Layout.Section>
          {fetcherData && !fetcherData.ok && fetcherData.error ? (
            <Banner tone="critical">Save failed: {fetcherData.error}</Banner>
          ) : null}
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Dunning</Text>
              <FormLayout>
                <TextField
                  label="Retry attempts before flagging for review"
                  type="number"
                  value={form.dunningRetryCount}
                  onChange={(v) => setForm((p) => ({ ...p, dunningRetryCount: v }))}
                  error={errors.dunningRetryCount}
                  autoComplete="off"
                  min={1}
                  max={10}
                />
                <TextField
                  label="Hours between retries"
                  type="number"
                  value={form.dunningRetryHours}
                  onChange={(v) => setForm((p) => ({ ...p, dunningRetryHours: v }))}
                  error={errors.dunningRetryHours}
                  autoComplete="off"
                  min={1}
                  max={168}
                />
              </FormLayout>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Reminders</Text>
              <FormLayout>
                <TextField
                  label="Send renewal reminder this many days before charge"
                  type="number"
                  value={form.renewalReminderDays}
                  onChange={(v) => setForm((p) => ({ ...p, renewalReminderDays: v }))}
                  error={errors.renewalReminderDays}
                  autoComplete="off"
                  min={1}
                  max={14}
                />
              </FormLayout>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Retention offer</Text>
              <FormLayout>
                <TextField
                  label="Discount % offered in the cancel flow"
                  type="number"
                  value={form.retentionOfferPct}
                  onChange={(v) => setForm((p) => ({ ...p, retentionOfferPct: v }))}
                  error={errors.retentionOfferPct}
                  autoComplete="off"
                  min={0}
                  max={50}
                />
              </FormLayout>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Billing</Text>
              <FormLayout>
                <TextField
                  label="Default billing day of the month"
                  type="number"
                  value={form.billingDay}
                  onChange={(v) => setForm((p) => ({ ...p, billingDay: v }))}
                  error={errors.billingDay}
                  autoComplete="off"
                  min={1}
                  max={28}
                />
                <Checkbox
                  label="Allow prepaid cycles (3 / 6 / 12 months upfront)"
                  checked={form.enablePrepaid}
                  onChange={(v) => setForm((p) => ({ ...p, enablePrepaid: v }))}
                />
                <Checkbox
                  label="Allow gift subscriptions"
                  checked={form.enableGift}
                  onChange={(v) => setForm((p) => ({ ...p, enableGift: v }))}
                />
              </FormLayout>
            </BlockStack>
          </Card>
        </Layout.Section>
        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm">Tips</Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Three retries spaced 24 hours apart is the recommended default. Lengthen
                the gap if your customers commonly need a few days to update a card.
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                The retention discount is offered in the cancel modal; it does not
                automatically apply to renewals.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
