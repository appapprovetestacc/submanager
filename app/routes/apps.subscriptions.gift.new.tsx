import {
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  json,
} from "@remix-run/cloudflare";
import {
  shopFromProxyRequest,
  verifyAppProxySignature,
} from "~/lib/subscriptions/app-proxy";
import type { Env } from "../../load-context";
import { insertGift } from "~/lib/db.server";
import { isAllowedGiftCycle, totalPrepaidCents } from "~/lib/subscriptions/gift";
import { hashToken, generateMagicToken } from "~/lib/subscriptions/magic-link";

// Gift checkout entry. The theme-app-embed block POSTs the form here.
// We:
//   1. Validate the cycle count + emails
//   2. Generate a recipient_token (sha256-hashed, plaintext goes in
//      the buyer's confirmation + recipient's first email)
//   3. Persist the gift_subscriptions row (status=pending_setup)
//   4. Return a JSON receipt; the merchant's checkout extension can
//      use this to attach gift metadata to the Shopify order
//
// We deliberately do NOT call Shopify to create a draft order here —
// the embedded admin's checkout extension or webhook handler does
// that with merchant credentials. Keeping the proxy route storage-only
// avoids holding write_draft_orders scope from the storefront context.

interface GiftCreateResult {
  ok: boolean;
  giftId?: string;
  recipientPreviewUrl?: string;
  error?: string;
}

export async function loader() {
  // GET is unsupported on this endpoint.
  return new Response("Method Not Allowed", { status: 405 });
}

export async function action({ request, context }: ActionFunctionArgs): Promise<Response> {
  const url = new URL(request.url);
  const env = (context.cloudflare?.env ?? {}) as Env;
  if (env.SHOPIFY_API_SECRET && url.searchParams.get("signature")) {
    const ok = await verifyAppProxySignature(url, env.SHOPIFY_API_SECRET);
    if (!ok) throw new Response("Invalid signature", { status: 401 });
  }
  const shop = shopFromProxyRequest(url);
  if (!shop) {
    return json<GiftCreateResult>(
      { ok: false, error: "Missing shop param" },
      { status: 400 },
    );
  }

  const form = await request.formData();
  const cycles = Number.parseInt(String(form.get("cycles") ?? "0"), 10);
  if (!isAllowedGiftCycle(cycles)) {
    return json<GiftCreateResult>(
      { ok: false, error: "Choose 3, 6, or 12 deliveries." },
      { status: 400 },
    );
  }
  const buyerEmail = String(form.get("buyer_email") ?? "").trim().toLowerCase();
  const buyerName = String(form.get("buyer_name") ?? "").trim();
  const recipientEmail = String(form.get("recipient_email") ?? "")
    .trim()
    .toLowerCase();
  const recipientName = String(form.get("recipient_name") ?? "").trim() || null;
  const recipientAddress = String(form.get("recipient_address") ?? "").trim();
  const message = String(form.get("message") ?? "").trim() || null;
  const variantId = String(form.get("variant_id") ?? "");

  if (!buyerEmail || !buyerName) {
    return json<GiftCreateResult>(
      { ok: false, error: "Enter your name and email." },
      { status: 400 },
    );
  }
  if (!recipientEmail || !recipientAddress) {
    return json<GiftCreateResult>(
      { ok: false, error: "Enter recipient details." },
      { status: 400 },
    );
  }
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(buyerEmail)) {
    return json<GiftCreateResult>({ ok: false, error: "Invalid buyer email." }, { status: 400 });
  }
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(recipientEmail)) {
    return json<GiftCreateResult>({ ok: false, error: "Invalid recipient email." }, { status: 400 });
  }

  // Estimate amount: caller can pass an explicit per_cycle_cents value
  // for accurate pricing; otherwise we record 0 + let the merchant's
  // admin fill it in once Shopify Payments completes the prepayment.
  const perCycleCents = Math.max(
    0,
    Number.parseInt(String(form.get("per_cycle_cents") ?? "0"), 10) || 0,
  );
  const amountPaidCents = totalPrepaidCents(perCycleCents, cycles);

  const id = "gift_" + crypto.randomUUID();
  const recipientToken = generateMagicToken();
  const recipientTokenHash = await hashToken(recipientToken);
  const nowMs = Date.now();
  await insertGift(context, {
    id,
    shop,
    buyerCustomerId: buyerEmail,
    buyerEmail,
    recipientEmail,
    recipientName,
    recipientAddress: {
      raw: recipientAddress,
      variantId,
    },
    cyclesTotal: cycles,
    amountPaidCents,
    currency: String(form.get("currency") ?? "USD"),
    recipientTokenSha256: recipientTokenHash,
    message,
    nowMs,
  });

  const recipientPreviewUrl = `/apps/subscriptions/gift/${encodeURIComponent(recipientToken)}?shop=${encodeURIComponent(shop)}`;

  // Redirect strategy: send shopper back to product page with a
  // success query param so the storefront block can show a success
  // banner. The actual prepayment happens in the merchant's checkout
  // extension or post-purchase flow.
  const redirectTo = String(form.get("redirect") ?? "");
  if (redirectTo && /^\/[a-zA-Z0-9_\-/]*$/.test(redirectTo)) {
    return new Response(null, {
      status: 303,
      headers: {
        Location: `${redirectTo}?gift=${encodeURIComponent(id)}`,
      },
    });
  }

  return json<GiftCreateResult>({
    ok: true,
    giftId: id,
    recipientPreviewUrl,
  });
}
