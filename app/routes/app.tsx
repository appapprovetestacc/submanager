import {
  type LinksFunction,
  type LoaderFunctionArgs,
  type MetaFunction,
  json,
} from "@remix-run/cloudflare";
import { Outlet, useLoaderData } from "@remix-run/react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { AppProvider } from "@shopify/polaris";
import enTranslations from "@shopify/polaris/locales/en.json";

// Layout for every embedded-admin route. Wraps children in Polaris
// AppProvider + injects the App Bridge meta tag so child routes can
// use `useAppBridge()`. The top-level navigation from Shopify admin
// has no Authorization header, so we don't call authenticate.admin
// here — the AppProvider renders the shell, and any auth-required
// loader on a child route handles its own auth.

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: polarisStyles },
];

export async function loader({ request, context }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") ?? "";
  const env = context.cloudflare?.env as { SHOPIFY_API_KEY?: string } | undefined;
  return json({
    shop,
    apiKey: env?.SHOPIFY_API_KEY ?? "",
  });
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: "SubManager" },
  { name: "shopify-api-key", content: data?.apiKey ?? "" },
];

export default function AppLayout() {
  const { shop } = useLoaderData<typeof loader>();
  return (
    <AppProvider i18n={enTranslations}>
      <Outlet context={{ shop }} />
      <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" defer />
    </AppProvider>
  );
}
