import {
  type LoaderFunctionArgs,
  type ActionFunctionArgs,
  json,
} from "@remix-run/cloudflare";
import {
  useFetcher,
  useLoaderData,
  useNavigate,
  useSearchParams,
} from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Card,
  EmptyState,
  IndexTable,
  InlineGrid,
  Page,
  Pagination,
  SkeletonBodyText,
  SkeletonDisplayText,
  Tabs,
  Text,
  useIndexResourceState,
} from "@shopify/polaris";
import { useEffect, useState } from "react";
import {
  hasD1,
  listContracts,
  listContractsForRollup,
  recordAction,
  updateContractStatus,
  type ContractRow,
} from "~/lib/db.server";
import { rollupDashboard, formatChurnPct } from "~/lib/subscriptions/mrr";

type TabKey = "all" | "active" | "paused" | "cancelled" | "failed";

const TAB_DEFS: Array<{ key: TabKey; label: string; status?: ContractRow["status"] }> = [
  { key: "all", label: "All" },
  { key: "active", label: "Active", status: "active" },
  { key: "paused", label: "Paused", status: "paused" },
  { key: "cancelled", label: "Cancelled", status: "cancelled" },
  { key: "failed", label: "Failed", status: "failed" },
];

const PAGE_SIZE = 25;

export async function loader({ request, context }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") ?? "";
  const tab = (url.searchParams.get("tab") ?? "all") as TabKey;
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const sortDir: "asc" | "desc" =
    url.searchParams.get("sortDir") === "asc" ? "asc" : "desc";

  if (!shop || !hasD1(context)) {
    return json({
      shop,
      tab,
      page,
      sortDir,
      contracts: [] as ContractRow[],
      total: 0,
      rollup: {
        mrrCents: 0,
        activeCount: 0,
        pausedCount: 0,
        cancelledCount: 0,
        failedCount: 0,
        churn30d: 0,
      },
      configured: !!shop,
    });
  }

  const status = TAB_DEFS.find((t) => t.key === tab)?.status;
  const [page1, allForRollup] = await Promise.all([
    listContracts(context, {
      shop,
      status,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
      sortBy: "next_billing_at",
      sortDir,
    }),
    listContractsForRollup(context, shop),
  ]);

  const rollup = rollupDashboard(
    allForRollup.map((c) => ({
      status: c.status,
      amountCents: c.amount_cents,
      frequency: { interval: c.interval, intervalCount: c.interval_count },
      createdAt: c.created_at,
      cancelledAt: c.cancelled_at,
    })),
    Date.now(),
  );

  return json({
    shop,
    tab,
    page,
    sortDir,
    contracts: page1.rows,
    total: page1.total,
    rollup,
    configured: true,
  });
}

export async function action({ request, context }: ActionFunctionArgs) {
  const form = await request.formData();
  const shop = String(form.get("shop") ?? "");
  const intent = String(form.get("intent") ?? "");
  if (!shop || intent !== "bulk_pause") {
    return json({ ok: false, error: "Unsupported intent" }, { status: 400 });
  }
  const ids = form.getAll("ids").map(String);
  if (ids.length === 0) return json({ ok: true, paused: 0 });
  const nowMs = Date.now();
  for (const id of ids) {
    await updateContractStatus(context, {
      shop,
      shopifyContractId: id,
      status: "paused",
      pausedUntil: nowMs + 30 * 86_400_000,
      nowMs,
    });
    await recordAction(context, {
      shop,
      shopifyContractId: id,
      action: "pause",
      actor: "merchant",
      note: "bulk_pause from dashboard",
      nowMs,
    });
  }
  return json({ ok: true, paused: ids.length });
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

function statusBadge(status: ContractRow["status"]) {
  switch (status) {
    case "active":
      return <Badge tone="success">Active</Badge>;
    case "paused":
      return <Badge tone="attention">Paused</Badge>;
    case "failed":
      return <Badge tone="critical">Failed</Badge>;
    case "cancelled":
      return <Badge>Cancelled</Badge>;
    case "expired":
      return <Badge>Expired</Badge>;
  }
}

export default function SubscriptionsIndex() {
  const data = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const fetcher = useFetcher<typeof action>();
  const [params, setParams] = useSearchParams();
  const [isHydrated, setIsHydrated] = useState(false);
  useEffect(() => setIsHydrated(true), []);

  const tabIndex = Math.max(
    0,
    TAB_DEFS.findIndex((t) => t.key === data.tab),
  );

  const resourceIds = data.contracts.map((c) => ({ id: c.shopify_contract_id }));
  const { selectedResources, allResourcesSelected, handleSelectionChange } =
    useIndexResourceState(resourceIds);

  const onTabChange = (idx: number) => {
    const key = TAB_DEFS[idx]?.key ?? "all";
    const next = new URLSearchParams(params);
    next.set("tab", key);
    next.delete("page");
    setParams(next);
  };

  const onSort = (_col: string, dir: "asc" | "desc") => {
    const next = new URLSearchParams(params);
    next.set("sortDir", dir);
    setParams(next);
  };

  const onNextPage = () => {
    const next = new URLSearchParams(params);
    next.set("page", String((data.page ?? 1) + 1));
    setParams(next);
  };
  const onPrevPage = () => {
    const next = new URLSearchParams(params);
    next.set("page", String(Math.max(1, (data.page ?? 1) - 1)));
    setParams(next);
  };

  const hasNext = data.page * PAGE_SIZE < data.total;
  const hasPrev = data.page > 1;

  const bulkPause = () => {
    const fd = new FormData();
    fd.set("shop", data.shop);
    fd.set("intent", "bulk_pause");
    for (const id of selectedResources) fd.append("ids", id);
    fetcher.submit(fd, { method: "post" });
  };

  if (!isHydrated && data.total === 0 && data.configured) {
    return <SubscriptionsSkeleton />;
  }

  if (!data.configured) {
    return (
      <Page title="Subscriptions">
        <Banner tone="warning">
          Open this app from your Shopify admin to load your store's data.
        </Banner>
      </Page>
    );
  }

  return (
    <Page
      title="Subscriptions"
      primaryAction={{ content: "New selling plan", onAction: () => navigate(`/app/plans/new?shop=${encodeURIComponent(data.shop)}`) }}
      secondaryActions={[
        { content: "Settings", onAction: () => navigate(`/app/settings?shop=${encodeURIComponent(data.shop)}`) },
        { content: "Failed payments", onAction: () => navigate(`/app/dunning?shop=${encodeURIComponent(data.shop)}`) },
      ]}
    >
      <BlockStack gap="400">
        {data.rollup.failedCount > 0 ? (
          <Banner
            tone="critical"
            title={`${data.rollup.failedCount} subscriptions with failed payments`}
            action={{
              content: "Review failed payments",
              onAction: () =>
                navigate(`/app/dunning?shop=${encodeURIComponent(data.shop)}`),
            }}
          >
            <p>These subscriptions need a payment-method update before the next charge.</p>
          </Banner>
        ) : null}

        <OnboardingBanner shop={data.shop} hasData={data.total > 0} />

        <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
          <MetricTile label="MRR" value={formatCents(data.rollup.mrrCents)} />
          <MetricTile label="Active subscriptions" value={String(data.rollup.activeCount)} />
          <MetricTile label="Churn (30d)" value={formatChurnPct(data.rollup.churn30d)} />
          <MetricTile
            label="Failed payments"
            value={String(data.rollup.failedCount)}
            tone={data.rollup.failedCount > 0 ? "critical" : "subdued"}
          />
        </InlineGrid>

        <Card padding="0">
          <Tabs
            tabs={TAB_DEFS.map((t) => ({ id: t.key, content: t.label, panelID: t.key }))}
            selected={tabIndex}
            onSelect={onTabChange}
          />
          {data.contracts.length === 0 ? (
            <Box padding="800">
              <EmptyState
                heading="Add your first subscription plan"
                action={{
                  content: "Create selling plan",
                  onAction: () =>
                    navigate(`/app/plans/new?shop=${encodeURIComponent(data.shop)}`),
                }}
                secondaryAction={{
                  content: "Learn more",
                  url: "https://shopify.dev/docs/apps/build/purchase-options/subscriptions",
                  external: true,
                }}
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>
                  Subscriptions appear here as customers sign up. Configure a selling
                  plan to start collecting recurring orders.
                </p>
              </EmptyState>
            </Box>
          ) : (
            <>
              <IndexTable
                resourceName={{ singular: "subscription", plural: "subscriptions" }}
                itemCount={data.contracts.length}
                selectedItemsCount={
                  allResourcesSelected ? "All" : selectedResources.length
                }
                onSelectionChange={handleSelectionChange}
                selectable
                sortable={[false, false, true, false]}
                onSort={(col, dir) =>
                  onSort(String(col), dir === "ascending" ? "asc" : "desc")
                }
                sortDirection={data.sortDir === "asc" ? "ascending" : "descending"}
                sortColumnIndex={2}
                promotedBulkActions={[
                  {
                    content: "Pause selected",
                    onAction: bulkPause,
                  },
                ]}
                headings={[
                  { title: "Customer" },
                  { title: "Status" },
                  { title: "Next billing" },
                  { title: "Amount" },
                ]}
              >
                {data.contracts.map((c, index) => (
                  <IndexTable.Row
                    id={c.shopify_contract_id}
                    key={c.shopify_contract_id}
                    position={index}
                    selected={selectedResources.includes(c.shopify_contract_id)}
                    onClick={() =>
                      navigate(
                        `/app/subscriptions/${encodeURIComponent(
                          c.shopify_contract_id,
                        )}?shop=${encodeURIComponent(data.shop)}`,
                      )
                    }
                  >
                    <IndexTable.Cell>
                      <Text variant="bodyMd" fontWeight="medium" as="span">
                        {c.customer_email || c.customer_id}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>{statusBadge(c.status)}</IndexTable.Cell>
                    <IndexTable.Cell>
                      {c.next_billing_at
                        ? new Intl.DateTimeFormat("en-US", {
                            year: "numeric",
                            month: "short",
                            day: "numeric",
                          }).format(new Date(c.next_billing_at))
                        : "—"}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {formatCents(c.amount_cents, c.currency)}
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
              {hasNext || hasPrev ? (
                <Box padding="300">
                  <Pagination
                    hasNext={hasNext}
                    hasPrevious={hasPrev}
                    onNext={onNextPage}
                    onPrevious={onPrevPage}
                  />
                </Box>
              ) : null}
            </>
          )}
        </Card>
      </BlockStack>
    </Page>
  );
}

function MetricTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "critical" | "subdued";
}) {
  return (
    <Card>
      <BlockStack gap="200">
        <Text as="p" variant="bodySm" tone="subdued">
          {label}
        </Text>
        <Text
          as="p"
          variant="heading2xl"
          fontWeight="bold"
          tone={tone === "critical" ? "critical" : undefined}
        >
          {value}
        </Text>
      </BlockStack>
    </Card>
  );
}

function OnboardingBanner({ shop, hasData }: { shop: string; hasData: boolean }) {
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (typeof window !== "undefined") {
      setDismissed(
        window.localStorage.getItem("submanager-onboarding-dismissed") === "1",
      );
    }
  }, []);
  if (dismissed || hasData) return null;
  const setupLink = (path: string) =>
    `${path}?shop=${encodeURIComponent(shop)}`;
  return (
    <Banner
      title="Finish setting up SubManager"
      tone="info"
      onDismiss={() => {
        if (typeof window !== "undefined") {
          window.localStorage.setItem("submanager-onboarding-dismissed", "1");
        }
        setDismissed(true);
      }}
    >
      <BlockStack gap="100">
        <Text as="p">A quick three-step setup gets your first subscription live:</Text>
        <Text as="p">1. Create a selling plan — <a href={setupLink("/app/plans/new")}>open the wizard</a></Text>
        <Text as="p">2. Configure dunning and renewal-reminder settings — <a href={setupLink("/app/settings")}>open settings</a></Text>
        <Text as="p">3. Install the storefront block on a test product to confirm checkout.</Text>
      </BlockStack>
    </Banner>
  );
}

function SubscriptionsSkeleton() {
  return (
    <Page title="Subscriptions">
      <BlockStack gap="400">
        <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
          {[0, 1, 2, 3].map((i) => (
            <Card key={i}>
              <BlockStack gap="200">
                <SkeletonDisplayText size="small" />
                <SkeletonBodyText lines={1} />
              </BlockStack>
            </Card>
          ))}
        </InlineGrid>
        <Card>
          <SkeletonBodyText lines={6} />
        </Card>
      </BlockStack>
    </Page>
  );
}
