import {
  type LoaderFunctionArgs,
  json,
} from "@remix-run/cloudflare";
import { useLoaderData } from "@remix-run/react";
import {
  getGiftByRecipientToken,
  type GiftRow,
} from "~/lib/db.server";
import { hashToken } from "~/lib/subscriptions/magic-link";
import {
  shopFromProxyRequest,
  verifyAppProxySignature,
} from "~/lib/subscriptions/app-proxy";
import type { Env } from "../../load-context";

// Recipient delivery-schedule view. Recipient gets this URL in the
// gift email and can revisit it any time to see remaining deliveries
// — no login, no payment portal.

export async function loader({ params, request, context }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const env = (context.cloudflare?.env ?? {}) as Env;
  if (env.SHOPIFY_API_SECRET && url.searchParams.get("signature")) {
    const ok = await verifyAppProxySignature(url, env.SHOPIFY_API_SECRET);
    if (!ok) throw new Response("Invalid signature", { status: 401 });
  }
  const token = params.token ?? "";
  if (!token) {
    return json({ ok: false as const, reason: "missing_token" as const });
  }
  const hash = await hashToken(token);
  const gift = await getGiftByRecipientToken(context, hash);
  if (!gift) {
    return json({ ok: false as const, reason: "not_found" as const });
  }
  return json({ ok: true as const, gift });
}

export default function GiftRecipient() {
  const data = useLoaderData<typeof loader>();
  if (!data.ok) {
    return (
      <main style={pageStyle}>
        <div style={cardStyle}>
          <h1 style={headingStyle}>Gift not found</h1>
          <p>The link you opened isn't valid. If you're expecting a gift, ask the sender for a fresh link.</p>
        </div>
      </main>
    );
  }
  const g = data.gift;
  const address = parseAddress(g.recipient_address_json);
  return (
    <main style={pageStyle}>
      <div style={cardStyle}>
        <h1 style={headingStyle}>
          {g.recipient_name ? `Hi ${g.recipient_name},` : "Your gift subscription"}
        </h1>
        <p style={subtitleStyle}>
          {g.buyer_email} sent you a {g.cycles_total}-delivery subscription at {g.shop.replace(".myshopify.com", "")}.
        </p>
        {g.message ? (
          <blockquote style={messageStyle}>{g.message}</blockquote>
        ) : null}
        <section style={infoSection}>
          <h2 style={infoHeadingStyle}>Deliveries</h2>
          <p style={infoStyle}>
            {g.cycles_remaining} of {g.cycles_total} remaining
          </p>
          <ScheduleList total={g.cycles_total} remaining={g.cycles_remaining} />
        </section>
        <section style={infoSection}>
          <h2 style={infoHeadingStyle}>Delivery address</h2>
          <p style={infoStyle}>{address}</p>
        </section>
        <p style={footnoteStyle}>
          No payment portal is needed — your gift is already paid for. Reply to this page in your email if anything changes.
        </p>
      </div>
    </main>
  );
}

function parseAddress(json: string): string {
  try {
    const parsed = JSON.parse(json) as { raw?: string };
    return parsed.raw ?? "—";
  } catch {
    return "—";
  }
}

function ScheduleList({ total, remaining }: { total: number; remaining: number }) {
  const used = total - remaining;
  return (
    <ol style={scheduleListStyle}>
      {Array.from({ length: total }).map((_, i) => {
        const delivered = i < used;
        return (
          <li key={i} style={{ ...scheduleItemStyle, opacity: delivered ? 0.5 : 1 }}>
            <span style={{ ...badgeStyle, ...(delivered ? badgeDoneStyle : badgePendingStyle) }}>
              {delivered ? "Delivered" : "Upcoming"}
            </span>
            <span>Delivery {i + 1}</span>
          </li>
        );
      })}
    </ol>
  );
}

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  padding: 24,
  background: "var(--color-background, #fafafa)",
  color: "var(--color-foreground, #111)",
  fontFamily: "var(--font-body-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif)",
  display: "flex",
  justifyContent: "center",
};
const cardStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 600,
  padding: 28,
  background: "#fff",
  borderRadius: 12,
  boxShadow: "0 2px 12px rgba(0,0,0,0.05)",
  boxSizing: "border-box",
};
const headingStyle: React.CSSProperties = { margin: "0 0 8px", fontSize: "1.5rem", fontWeight: 700 };
const subtitleStyle: React.CSSProperties = { margin: "0 0 16px", color: "rgba(0,0,0,0.6)", fontSize: "1rem" };
const messageStyle: React.CSSProperties = {
  margin: "0 0 16px",
  padding: "12px 16px",
  borderLeft: "3px solid var(--color-button, #111)",
  background: "rgba(0,0,0,0.03)",
  fontStyle: "italic",
};
const infoSection: React.CSSProperties = { marginTop: 20 };
const infoHeadingStyle: React.CSSProperties = { margin: "0 0 4px", fontSize: "0.95rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" };
const infoStyle: React.CSSProperties = { margin: "0 0 8px", fontSize: "0.95rem", whiteSpace: "pre-line" };
const footnoteStyle: React.CSSProperties = { marginTop: 24, color: "rgba(0,0,0,0.55)", fontSize: "0.85rem" };
const scheduleListStyle: React.CSSProperties = { listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 };
const scheduleItemStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 12 };
const badgeStyle: React.CSSProperties = { padding: "4px 10px", borderRadius: 999, fontSize: "0.75rem", fontWeight: 600, textTransform: "uppercase" };
const badgeDoneStyle: React.CSSProperties = { background: "rgba(0,128,96,0.1)", color: "rgb(0,96,72)" };
const badgePendingStyle: React.CSSProperties = { background: "rgba(0,0,0,0.05)", color: "rgba(0,0,0,0.6)" };
