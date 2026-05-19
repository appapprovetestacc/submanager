import {
  type LoaderFunctionArgs,
  redirect,
} from "@remix-run/cloudflare";
import {
  buildInstallUrl,
  isValidShop,
  shopifyApi,
  signedState,
} from "~/lib/shopify.server";

// GET /auth?shop=<store>.myshopify.com
// Initiates the Shopify OAuth install flow.
//
// F-NEW-AM — state is a server-signed token (HMAC over shop|nonce|expiry)
// rather than a cookie. Cookie-based state failed on Chromium 120+ when
// the OAuth callback came from a cross-site context (admin.shopify.com)
// because SameSite=Lax cookies are stripped on that hop under modern
// browser policies, producing "State mismatch" 401 on every install.
// Signed state is stateless + survives any cookie policy.
export async function loader({ request, context }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  if (!shop || !isValidShop(shop)) {
    return new Response("Missing or invalid ?shop=<name>.myshopify.com", {
      status: 400,
    });
  }
  const api = shopifyApi(context);
  const state = await signedState({ shop, apiSecret: api.apiSecret });
  const redirectUri = `${api.appUrl.replace(/\/$/, "")}/auth/callback`;
  const installUrl = buildInstallUrl({
    shop,
    apiKey: api.apiKey,
    scopes: api.scopes,
    redirectUri,
    state,
  });
  return new Response(null, {
    status: 302,
    headers: { Location: installUrl },
  });
}

export default function AuthStart() {
  return null;
}
