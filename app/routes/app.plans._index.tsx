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

interface PlanGroup {
  id: string;
  name: string;
  merchantCode: string;
  appliesTo: number;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") ?? "";
  // The Plans list is best populated by querying Shopify directly via
  // GraphQL; without a JWT-authenticated session we can't reach Admin
  // API at top-level load. Render an empty/seed state and let the user
  // navigate to the wizard. The wizard does the mutation under JWT.
  return json<{ shop: string; plans: PlanGroup[] }>({ shop, plans: [] });
}

export default function PlansIndex() {
  const data = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [tab, setTab] = useState(0);
  const { selectedResources, allResourcesSelected, handleSelectionChange } =
    useIndexResourceState(data.plans);

  const tabs = [
    { id: "all", content: "All", panelID: "all" },
    { id: "active", content: "Active", panelID: "active" },
  ];

  return (
    <Page
      title="Selling plans"
      backAction={{
        content: "Subscriptions",
        url: `/app/subscriptions?shop=${encodeURIComponent(data.shop)}`,
      }}
      primaryAction={{
        content: "New selling plan",
        onAction: () =>
          navigate(`/app/plans/new?shop=${encodeURIComponent(data.shop)}`),
      }}
    >
      <Card padding="0">
        <Tabs tabs={tabs} selected={tab} onSelect={setTab} />
        {data.plans.length === 0 ? (
          <Box padding="800">
            <EmptyState
              heading="Create your first selling plan"
              action={{
                content: "Open wizard",
                onAction: () =>
                  navigate(`/app/plans/new?shop=${encodeURIComponent(data.shop)}`),
              }}
              secondaryAction={{
                content: "Learn more",
                url: "https://shopify.dev/docs/api/admin-graphql/latest/mutations/sellingPlanGroupCreate",
                external: true,
              }}
              image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
            >
              <p>
                A selling plan groups subscription frequencies and prepaid options. Attach one
                to a product to make it subscribable.
              </p>
            </EmptyState>
          </Box>
        ) : (
          <IndexTable
            resourceName={{ singular: "plan", plural: "plans" }}
            itemCount={data.plans.length}
            selectedItemsCount={
              allResourcesSelected ? "All" : selectedResources.length
            }
            onSelectionChange={handleSelectionChange}
            selectable
            sortable={[true, false, true]}
            headings={[{ title: "Name" }, { title: "Code" }, { title: "Products" }]}
          >
            {data.plans.map((p, idx) => (
              <IndexTable.Row
                id={p.id}
                key={p.id}
                position={idx}
                selected={selectedResources.includes(p.id)}
                onClick={() => navigate(`/app/plans/${encodeURIComponent(p.id)}?shop=${encodeURIComponent(data.shop)}`)}
              >
                <IndexTable.Cell>
                  <Text as="span" fontWeight="medium">{p.name}</Text>
                </IndexTable.Cell>
                <IndexTable.Cell>{p.merchantCode}</IndexTable.Cell>
                <IndexTable.Cell>
                  <Badge>{String(p.appliesTo)}</Badge>
                </IndexTable.Cell>
              </IndexTable.Row>
            ))}
          </IndexTable>
        )}
      </Card>
    </Page>
  );
}
