import { type LoaderFunctionArgs, json } from "@remix-run/cloudflare";
import { useLoaderData, useNavigate } from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Box,
  Card,
  EmptyState,
  IndexTable,
  Page,
  Tabs,
  Text,
  useIndexResourceState,
} from "@shopify/polaris";
import { useState } from "react";
import {
  listFailedDunningByShop,
  type DunningRow,
} from "~/lib/db.server";

export async function loader({ request, context }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") ?? "";
  if (!shop) return json<{ shop: string; rows: DunningRow[] }>({ shop, rows: [] });
  const rows = await listFailedDunningByShop(context, shop);
  return json({ shop, rows });
}

export default function DunningIndex() {
  const data = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [tab, setTab] = useState(0);
  const { selectedResources, allResourcesSelected, handleSelectionChange } =
    useIndexResourceState(data.rows.map((r) => ({ id: String(r.id) })));

  return (
    <Page
      title="Failed payments"
      backAction={{
        content: "Subscriptions",
        url: `/app/subscriptions?shop=${encodeURIComponent(data.shop)}`,
      }}
    >
      <Card padding="0">
        <Tabs
          tabs={[
            { id: "needs-attention", content: "Needs attention", panelID: "needs-attention" },
            { id: "all", content: "All", panelID: "all" },
          ]}
          selected={tab}
          onSelect={setTab}
        />
        {data.rows.length === 0 ? (
          <Box padding="800">
            <EmptyState
              heading="No failed payments"
              action={{
                content: "Back to subscriptions",
                onAction: () =>
                  navigate(`/app/subscriptions?shop=${encodeURIComponent(data.shop)}`),
              }}
              secondaryAction={{
                content: "Learn about dunning",
                url: "https://shopify.dev/docs/apps/build/purchase-options/subscriptions",
                external: true,
              }}
              image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
            >
              <p>When a renewal charge fails, the row appears here. Currently everything is up to date.</p>
            </EmptyState>
          </Box>
        ) : (
          <IndexTable
            resourceName={{ singular: "alert", plural: "alerts" }}
            itemCount={data.rows.length}
            selectedItemsCount={
              allResourcesSelected ? "All" : selectedResources.length
            }
            onSelectionChange={handleSelectionChange}
            selectable
            sortable={[false, true, false, true]}
            headings={[
              { title: "Contract" },
              { title: "Attempt" },
              { title: "Last error" },
              { title: "Last updated" },
            ]}
          >
            {data.rows.map((r, idx) => (
              <IndexTable.Row
                id={String(r.id)}
                key={r.id}
                position={idx}
                selected={selectedResources.includes(String(r.id))}
                onClick={() =>
                  navigate(
                    `/app/subscriptions/${encodeURIComponent(r.shopify_contract_id)}?shop=${encodeURIComponent(r.shop)}`,
                  )
                }
              >
                <IndexTable.Cell>
                  <Text as="span" fontWeight="medium">
                    {r.shopify_contract_id}
                  </Text>
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <Badge tone="critical">{`${r.attempt_count} / 3`}</Badge>
                </IndexTable.Cell>
                <IndexTable.Cell>{r.last_error ?? "—"}</IndexTable.Cell>
                <IndexTable.Cell>
                  {new Intl.DateTimeFormat("en-US", {
                    dateStyle: "short",
                    timeStyle: "short",
                  }).format(new Date(r.updated_at))}
                </IndexTable.Cell>
              </IndexTable.Row>
            ))}
          </IndexTable>
        )}
      </Card>
    </Page>
  );
}
