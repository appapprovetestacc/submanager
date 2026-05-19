// Shopify App-Proxy request validation.
// Spec: https://shopify.dev/docs/apps/build/online-store/app-proxies#calculate-a-digital-signature
//
// Shopify hashes the query-string params with the app secret and
// includes the result as the `signature` param. We recompute and
// constant-time compare.

export async function verifyAppProxySignature(
  url: URL,
  apiSecret: string,
): Promise<boolean> {
  const signature = url.searchParams.get("signature");
  if (!signature) return false;
  const entries: Array<[string, string]> = [];
  url.searchParams.forEach((v, k) => {
    if (k !== "signature") entries.push([k, v]);
  });
  entries.sort(([a], [b]) => a.localeCompare(b));
  const message = entries.map(([k, v]) => `${k}=${v}`).join("");

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(apiSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, enc.encode(message)),
  );
  let expected = "";
  for (let i = 0; i < sig.length; i++) {
    expected += sig[i]!.toString(16).padStart(2, "0");
  }
  if (expected.length !== signature.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return mismatch === 0;
}

export function shopFromProxyRequest(url: URL): string | null {
  const shop = url.searchParams.get("shop");
  return shop && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop) ? shop : null;
}

export function loggedInCustomerId(url: URL): string | null {
  const id = url.searchParams.get("logged_in_customer_id");
  return id ? id : null;
}
