import {
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  json,
  redirect,
} from "@remix-run/cloudflare";
import {
  useFetcher,
  useLoaderData,
  useNavigate,
  useParams,
} from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  FormLayout,
  InlineStack,
  Layout,
  Modal,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { useState } from "react";
import {
  getActiveDunning,
  getContract,
  getSettings,
  listActionsForContract,
  recordAction,
  updateContractStatus,
} from "~/lib/db.server";
import { addInterval, type Interval } from "~/lib/subscriptions/frequency";

export async function loader({ params, request, context }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") ?? "";
  const id = params.id ?? "";
  if (!shop || !id) {
    return json({ found: false as const, shop });
  }
  const [contract, dunning, settings, actions] = await Promise.all([
    getContract(context, shop, id),
    getActiveDunning(context, shop, id),
    getSettings(context, shop),
    listActionsForContract(context, shop, id, 50),
  ]);
  if (!contract) return json({ found: false as const, shop });
  return json({
    found: true as const,
    shop,
    contract,
    dunning,
    settings,
    actions,
  });
}

export async function action({ params, request, context }: ActionFunctionArgs) {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") ?? "";
  const id = params.id ?? "";
  if (!shop || !id) return json({ ok: false, error: "missing params" }, { status: 400 });
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const nowMs = Date.now();
  const contract = await getContract(context, shop, id);
  if (!contract) return json({ ok: false, error: "not found" }, { status: 404 });

  switch (intent) {
    case "pause": {
      const days = Number.parseInt(String(form.get("days") ?? "30"), 10) || 30;
      const pauseUntil = nowMs + days * 86_400_000;
      await updateContractStatus(context, {
        shop,
        shopifyContractId: id,
        status: "paused",
        pausedUntil: pauseUntil,
        nowMs,
      });
      await recordAction(context, {
        shop,
        shopifyContractId: id,
        action: "pause",
        actor: "merchant",
        oldState: { status: contract.status },
        newState: { status: "paused", pausedUntil: pauseUntil },
        note: `pause ${days}d`,
        nowMs,
      });
      return json({ ok: true });
    }
    case "reactivate": {
      const nextBilling =
        contract.next_billing_at && contract.next_billing_at > nowMs
          ? contract.next_billing_at
          : nowMs + 86_400_000;
      await updateContractStatus(context, {
        shop,
        shopifyContractId: id,
        status: "active",
        pausedUntil: null,
        nextBillingAt: nextBilling,
        nowMs,
      });
      await recordAction(context, {
        shop,
        shopifyContractId: id,
        action: "reactivate",
        actor: "merchant",
        oldState: { status: contract.status },
        newState: { status: "active" },
        nowMs,
      });
      return json({ ok: true });
    }
    case "skip": {
      if (!contract.next_billing_at) {
        return json({ ok: false, error: "no_next_billing" }, { status: 400 });
      }
      const next = addInterval(contract.next_billing_at, {
        interval: contract.interval,
        intervalCount: contract.interval_count,
      });
      await updateContractStatus(context, {
        shop,
        shopifyContractId: id,
        status: contract.status,
        nextBillingAt: next,
        nowMs,
      });
      await recordAction(context, {
        shop,
        shopifyContractId: id,
        action: "skip",
        actor: "merchant",
        oldState: { nextBillingAt: contract.next_billing_at },
        newState: { nextBillingAt: next },
        nowMs,
      });
      return json({ ok: true });
    }
    case "cancel": {
      await updateContractStatus(context, {
        shop,
        shopifyContractId: id,
        status: "cancelled",
        cancelledAt: nowMs,
        nowMs,
      });
      await recordAction(context, {
        shop,
        shopifyContractId: id,
        action: "cancel",
        actor: "merchant",
        oldState: { status: contract.status },
        newState: { status: "cancelled" },
        note: String(form.get("note") ?? ""),
        nowMs,
      });
      return json({ ok: true });
    }
    case "change_frequency": {
      const interval = (String(form.get("interval") ?? "month") as Interval);
      const intervalCount =
        Math.max(1, Number.parseInt(String(form.get("intervalCount") ?? "1"), 10) || 1);
      await updateContractStatus(context, {
        shop,
        shopifyContractId: id,
        status: contract.status,
        intervalCount,
        nowMs,
      });
      await recordAction(context, {
        shop,
        shopifyContractId: id,
        action: "change_frequency",
        actor: "merchant",
        oldState: { interval: contract.interval, intervalCount: contract.interval_count },
        newState: { interval, intervalCount },
        nowMs,
      });
      return json({ ok: true });
    }
    case "retry_payment": {
      await recordAction(context, {
        shop,
        shopifyContractId: id,
        action: "dunning",
        actor: "merchant",
        note: "manual_retry_requested",
        nowMs,
      });
      return json({ ok: true });
    }
    default:
      return json({ ok: false, error: "unknown intent" }, { status: 400 });
  }
}

function formatCents(cents: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
      cents / 100,
    );
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

export default function SubscriptionDetail() {
  const data = useLoaderData<typeof loader>();
  const params = useParams();
  const navigate = useNavigate();
  const fetcher = useFetcher<typeof action>();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [pauseDays, setPauseDays] = useState("30");
  const [freqInterval, setFreqInterval] = useState<Interval>("month");
  const [freqCount, setFreqCount] = useState("1");

  if (!data.found) {
    return (
      <Page
        backAction={{ content: "Subscriptions", url: `/app/subscriptions?shop=${encodeURIComponent(data.shop ?? "")}` }}
        title="Subscription not found"
      >
        <Banner tone="warning">
          We couldn't find this subscription. It may have been deleted.
        </Banner>
      </Page>
    );
  }

  const { contract, dunning, actions } = data;
  const isSubmitting = fetcher.state !== "idle";

  const submit = (intent: string, extra: Record<string, string> = {}) => {
    const fd = new FormData();
    fd.set("intent", intent);
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    fetcher.submit(fd, { method: "post" });
  };

  return (
    <Page
      backAction={{
        content: "Subscriptions",
        url: `/app/subscriptions?shop=${encodeURIComponent(data.shop)}`,
      }}
      title={contract.customer_email || contract.customer_id}
      titleMetadata={
        contract.status === "active" ? (
          <Badge tone="success">Active</Badge>
        ) : contract.status === "paused" ? (
          <Badge tone="attention">Paused</Badge>
        ) : contract.status === "failed" ? (
          <Badge tone="critical">Failed</Badge>
        ) : (
          <Badge>{contract.status}</Badge>
        )
      }
      primaryAction={
        contract.status === "active"
          ? { content: "Pause", onAction: () => submit("pause", { days: "30" }) }
          : contract.status === "paused"
            ? { content: "Reactivate", onAction: () => submit("reactivate") }
            : undefined
      }
      secondaryActions={[
        {
          content: "Cancel subscription",
          destructive: true,
          onAction: () => setCancelOpen(true),
          disabled: contract.status === "cancelled",
        },
      ]}
    >
      <Layout>
        <Layout.Section>
          {contract.status === "failed" && dunning ? (
            <Banner
              tone="critical"
              title={`Payment failed (attempt ${dunning.attempt_count} of ${data.settings.dunning_retry_count})`}
              action={{
                content: "Retry payment now",
                onAction: () => submit("retry_payment"),
              }}
              secondaryAction={{
                content: "Send dunning email",
                onAction: () => submit("retry_payment"),
              }}
            >
              <p>{dunning.last_error ?? "The most recent renewal charge was declined."}</p>
            </Banner>
          ) : null}

          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Plan</Text>
              <Text as="p">
                {formatCents(contract.amount_cents, contract.currency)} every{" "}
                {contract.interval_count} {contract.interval}
                {contract.interval_count > 1 ? "s" : ""}
              </Text>
              <Text as="p" tone="subdued">
                Next billing:{" "}
                {contract.next_billing_at
                  ? new Intl.DateTimeFormat("en-US", { dateStyle: "long" }).format(
                      new Date(contract.next_billing_at),
                    )
                  : "—"}
              </Text>
              <InlineStack gap="200">
                <Button onClick={() => submit("skip")} disabled={isSubmitting || !contract.next_billing_at}>
                  Skip next charge
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Change frequency</Text>
              <FormLayout>
                <Select
                  label="Interval"
                  options={[
                    { label: "Day", value: "day" },
                    { label: "Week", value: "week" },
                    { label: "Month", value: "month" },
                    { label: "Year", value: "year" },
                  ]}
                  value={freqInterval}
                  onChange={(v) => setFreqInterval(v as Interval)}
                />
                <TextField
                  label="Every N"
                  type="number"
                  value={freqCount}
                  onChange={setFreqCount}
                  autoComplete="off"
                  min={1}
                  max={52}
                />
                <Button
                  variant="primary"
                  loading={isSubmitting}
                  disabled={isSubmitting}
                  onClick={() =>
                    submit("change_frequency", {
                      interval: freqInterval,
                      intervalCount: freqCount,
                    })
                  }
                >
                  Save frequency
                </Button>
              </FormLayout>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Activity</Text>
              {actions.length === 0 ? (
                <Text as="p" tone="subdued">No activity yet.</Text>
              ) : (
                <BlockStack gap="200">
                  {actions.map((a) => (
                    <InlineStack key={a.id} gap="200" align="space-between">
                      <InlineStack gap="200">
                        <Badge tone={badgeTone(a.action)}>{a.action}</Badge>
                        <Text as="span" variant="bodySm" tone="subdued">
                          {new Intl.DateTimeFormat("en-US", {
                            dateStyle: "short",
                            timeStyle: "short",
                          }).format(new Date(a.created_at))}
                        </Text>
                      </InlineStack>
                      <Text as="span" variant="bodySm">
                        {a.note ?? a.actor}
                      </Text>
                    </InlineStack>
                  ))}
                </BlockStack>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm">Customer</Text>
              <Text as="p" variant="bodySm">
                {contract.customer_email || "—"}
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                ID: {contract.customer_id}
              </Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm">Items</Text>
              <Text as="p" variant="bodySm">
                {summariseLines(contract.line_items_json)}
              </Text>
            </BlockStack>
          </Card>
          {contract.is_gift ? (
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">Gift subscription</Text>
                <Text as="p" variant="bodySm">
                  {contract.prepaid_cycles > 0
                    ? `${contract.prepaid_cycles} cycles prepaid`
                    : "Prepaid"}
                </Text>
              </BlockStack>
            </Card>
          ) : null}
        </Layout.Section>
      </Layout>

      <Modal
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title="Before you cancel"
        primaryAction={{
          content: `Accept ${data.settings.retention_offer_pct}% off`,
          onAction: () => {
            submit("change_frequency", {
              interval: contract.interval,
              intervalCount: String(contract.interval_count),
            });
            setCancelOpen(false);
          },
        }}
        secondaryActions={[
          {
            content: "Cancel anyway",
            destructive: true,
            onAction: () => {
              submit("cancel");
              setCancelOpen(false);
            },
          },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="200">
            <Text as="p">
              Stay subscribed and get {data.settings.retention_offer_pct}% off the
              next renewal — or pause for a month instead.
            </Text>
            <Button
              onClick={() => {
                submit("pause", { days: "30" });
                setCancelOpen(false);
              }}
            >
              Pause for 1 month
            </Button>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

function badgeTone(action: string): "success" | "attention" | "critical" | undefined {
  if (action === "created" || action === "reactivate") return "success";
  if (action === "pause" || action === "renewal_reminder") return "attention";
  if (action === "cancel" || action === "dunning") return "critical";
  return undefined;
}

function summariseLines(json: string): string {
  try {
    const items = JSON.parse(json) as Array<{ title?: string; quantity?: number }>;
    if (!Array.isArray(items) || items.length === 0) return "—";
    return items.map((l) => `${l.title ?? "Item"} × ${l.quantity ?? 1}`).join(", ");
  } catch {
    return "—";
  }
}

export { redirect };
