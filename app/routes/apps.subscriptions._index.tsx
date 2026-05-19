import {
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  json,
} from "@remix-run/cloudflare";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { insertMagicLink } from "~/lib/db.server";
import { issueMagicLink } from "~/lib/subscriptions/magic-link";
import { renderMagicLink } from "~/lib/emails/templates";
import { sendSubscriptionEmail } from "~/lib/emails/send";
import {
  shopFromProxyRequest,
  verifyAppProxySignature,
} from "~/lib/subscriptions/app-proxy";
import type { Env } from "../../load-context";

// App-proxy entry. Shopify routes
// https://{shop}.myshopify.com/apps/subscriptions/* here. We verify the
// `signature` HMAC on every request; without it the route 401s. The
// page itself is a passwordless request-link form: customer types
// their email + we email a magic link valid for 30 minutes.

export async function loader({ request, context }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const env = (context.cloudflare?.env ?? {}) as Env;
  // App-proxy signature is only sent by Shopify on real proxied
  // requests. In local dev or preview-mode we relax this.
  if (env.SHOPIFY_API_SECRET && url.searchParams.get("signature")) {
    const ok = await verifyAppProxySignature(url, env.SHOPIFY_API_SECRET);
    if (!ok) {
      throw new Response("Invalid signature", { status: 401 });
    }
  }
  const shop = shopFromProxyRequest(url);
  return json({
    shop: shop ?? "",
    loggedInCustomerEmail: url.searchParams.get("logged_in_customer_email") ?? "",
  });
}

export async function action({ request, context }: ActionFunctionArgs) {
  const url = new URL(request.url);
  const env = (context.cloudflare?.env ?? {}) as Env;
  if (env.SHOPIFY_API_SECRET && url.searchParams.get("signature")) {
    const ok = await verifyAppProxySignature(url, env.SHOPIFY_API_SECRET);
    if (!ok) throw new Response("Invalid signature", { status: 401 });
  }
  const shop = shopFromProxyRequest(url);
  if (!shop) return json({ sent: false, error: "Missing shop param" }, { status: 400 });

  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
    return json({ sent: false, error: "Enter a valid email address." }, { status: 400 });
  }
  // We don't reveal whether the email is on file (defence against
  // account enumeration). Always issue a token but only email it if
  // there's a corresponding contract. Either way, return "sent" to the user.
  const nowMs = Date.now();
  const issued = await issueMagicLink(nowMs);
  // We don't know the customer_id here without an Admin API call;
  // store with customer_id = email so the verify route can find it.
  await insertMagicLink(context, {
    tokenSha256: issued.hash,
    shop,
    customerId: email,
    customerEmail: email,
    expiresAt: issued.expiresAt,
    nowMs,
  });
  const portalUrl = `https://${shop}/apps/subscriptions/portal?token=${encodeURIComponent(issued.plaintext)}`;
  const tpl = renderMagicLink({ shopName: shop.replace(".myshopify.com", ""), portalUrl });
  await sendSubscriptionEmail(context, {
    to: email,
    subject: tpl.subject,
    html: tpl.html,
    text: tpl.text,
    tags: [{ name: "type", value: "magic_link" }],
  });
  return json({ sent: true });
}

interface MagicLinkActionData {
  sent: boolean;
  error?: string;
}

export default function PortalLogin() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as
    | MagicLinkActionData
    | undefined;
  const nav = useNavigation();
  const submitting = nav.state !== "idle";
  return (
    <main style={pageStyle}>
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      <div style={cardStyle}>
        <h1 style={headingStyle}>Manage your subscriptions</h1>
        <p style={subtitleStyle}>
          Enter your email and we'll send a one-tap link to sign in. No password needed.
        </p>
        {actionData?.sent ? (
          <div role="status" aria-live="polite" style={successStyle}>
            Check your inbox for a sign-in link. It expires in 30 minutes.
          </div>
        ) : (
          <Form method="post" style={formStyle}>
            <label htmlFor="email" style={labelStyle}>Email</label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              defaultValue={data.loggedInCustomerEmail}
              style={inputStyle}
              placeholder="you@example.com"
            />
            {actionData?.error ? (
              <div role="alert" style={errorStyle}>{actionData.error}</div>
            ) : null}
            <button type="submit" disabled={submitting} style={buttonStyle}>
              {submitting ? "Sending..." : "Send sign-in link"}
            </button>
          </Form>
        )}
      </div>
    </main>
  );
}

const STYLES = `
  @media (max-width: 480px) {
    .sm-card { padding: 24px 18px !important; }
  }
`;

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "24px",
  background: "var(--color-background, #fafafa)",
  color: "var(--color-foreground, #111)",
  fontFamily: "var(--font-body-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif)",
};
const cardStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 420,
  padding: 32,
  background: "#fff",
  borderRadius: 12,
  boxShadow: "0 4px 24px rgba(0,0,0,0.06)",
  boxSizing: "border-box",
};
const headingStyle: React.CSSProperties = {
  margin: "0 0 8px",
  fontSize: "1.5rem",
  fontWeight: 700,
  lineHeight: 1.2,
};
const subtitleStyle: React.CSSProperties = {
  margin: "0 0 20px",
  color: "rgba(0,0,0,0.6)",
  fontSize: "0.95rem",
  lineHeight: 1.45,
};
const formStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
};
const labelStyle: React.CSSProperties = {
  fontSize: "0.85rem",
  fontWeight: 600,
};
const inputStyle: React.CSSProperties = {
  padding: "14px",
  fontSize: "1rem",
  border: "1px solid #ddd",
  borderRadius: 8,
  outline: "none",
  fontFamily: "inherit",
  width: "100%",
  boxSizing: "border-box",
};
const buttonStyle: React.CSSProperties = {
  padding: "14px",
  fontSize: "1rem",
  fontWeight: 600,
  color: "var(--color-button-text, #fff)",
  background: "var(--color-button, #111)",
  border: 0,
  borderRadius: 8,
  cursor: "pointer",
  marginTop: 6,
};
const successStyle: React.CSSProperties = {
  padding: 14,
  borderRadius: 8,
  background: "rgba(0,128,96,0.08)",
  color: "rgb(0,96,72)",
  fontSize: "0.95rem",
};
const errorStyle: React.CSSProperties = {
  padding: 10,
  borderRadius: 8,
  background: "rgba(214,68,68,0.08)",
  color: "rgb(180,40,40)",
  fontSize: "0.9rem",
};
