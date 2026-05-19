import {
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  json,
  redirect,
} from "@remix-run/cloudflare";
import { Form, useFetcher, useLoaderData } from "@remix-run/react";
import {
  consumeMagicLink,
  getContract,
  getMagicLink,
  listContractsForCustomer,
  recordAction,
  updateContractStatus,
  type ContractRow,
} from "~/lib/db.server";
import { hashToken, verifyMagicLink } from "~/lib/subscriptions/magic-link";
import { addInterval, type Interval } from "~/lib/subscriptions/frequency";
import {
  buildPortalCookie,
  clearPortalCookie,
  readPortalCookie,
} from "~/lib/subscriptions/portal-session";
import {
  shopFromProxyRequest,
  verifyAppProxySignature,
} from "~/lib/subscriptions/app-proxy";
import type { Env } from "../../load-context";

// Portal entry — two flows:
//   1. ?token=... — initial redemption. Verify the token, mark used,
//      set a signed cookie, redirect to / (this page without token).
//   2. cookie present — render the portal with the customer's contracts.

export async function loader({ request, context }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const env = (context.cloudflare?.env ?? {}) as Env;
  if (env.SHOPIFY_API_SECRET && url.searchParams.get("signature")) {
    const ok = await verifyAppProxySignature(url, env.SHOPIFY_API_SECRET);
    if (!ok) throw new Response("Invalid signature", { status: 401 });
  }
  const shop = shopFromProxyRequest(url) ?? "";
  const token = url.searchParams.get("token");
  if (token) {
    const tokenHash = await hashToken(token);
    const row = await getMagicLink(context, tokenHash);
    const verified = verifyMagicLink(
      row
        ? {
            tokenSha256: row.token_sha256,
            shop: row.shop,
            customerId: row.customer_id,
            customerEmail: row.customer_email,
            expiresAt: row.expires_at,
            usedAt: row.used_at,
            createdAt: row.created_at,
          }
        : null,
      Date.now(),
    );
    if (!verified.ok) {
      return json({ ok: false as const, reason: verified.reason, shop });
    }
    const changes = await consumeMagicLink(context, tokenHash, Date.now());
    if (changes === 0) {
      return json({ ok: false as const, reason: "already_used", shop });
    }
    const cookie = await buildPortalCookie(context, {
      shop: row!.shop,
      customerId: row!.customer_id,
      issuedAt: Date.now(),
    });
    // Strip the token from the URL to keep it out of browser history.
    const cleanUrl = new URL(url);
    cleanUrl.searchParams.delete("token");
    return redirect(cleanUrl.pathname + cleanUrl.search, {
      headers: { "Set-Cookie": cookie },
    });
  }

  const session = await readPortalCookie(context, request);
  if (!session) {
    return json({ ok: false as const, reason: "no_session" as const, shop });
  }
  const contracts = await listContractsForCustomer(
    context,
    session.shop,
    session.customerId,
  );
  return json({
    ok: true as const,
    shop: session.shop,
    customerEmail: session.customerId, // we store email as customer_id pre-link
    contracts,
  });
}

export async function action({ request, context }: ActionFunctionArgs) {
  const url = new URL(request.url);
  const env = (context.cloudflare?.env ?? {}) as Env;
  if (env.SHOPIFY_API_SECRET && url.searchParams.get("signature")) {
    const ok = await verifyAppProxySignature(url, env.SHOPIFY_API_SECRET);
    if (!ok) throw new Response("Invalid signature", { status: 401 });
  }
  const session = await readPortalCookie(context, request);
  if (!session) {
    return json({ ok: false, error: "Sign in again." }, { status: 401 });
  }
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const id = String(form.get("contract") ?? "");
  if (!id) return json({ ok: false, error: "Missing contract" }, { status: 400 });
  const contract = await getContract(context, session.shop, id);
  if (!contract || contract.customer_id !== session.customerId) {
    return json({ ok: false, error: "Not authorised" }, { status: 403 });
  }
  const nowMs = Date.now();
  switch (intent) {
    case "pause": {
      const pauseUntil = nowMs + 30 * 86_400_000;
      await updateContractStatus(context, {
        shop: session.shop,
        shopifyContractId: id,
        status: "paused",
        pausedUntil: pauseUntil,
        nowMs,
      });
      await recordAction(context, {
        shop: session.shop,
        shopifyContractId: id,
        action: "pause",
        actor: "customer",
        newState: { pausedUntil: pauseUntil },
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
        shop: session.shop,
        shopifyContractId: id,
        status: "active",
        pausedUntil: null,
        nextBillingAt: nextBilling,
        nowMs,
      });
      await recordAction(context, {
        shop: session.shop,
        shopifyContractId: id,
        action: "reactivate",
        actor: "customer",
        nowMs,
      });
      return json({ ok: true });
    }
    case "skip": {
      if (!contract.next_billing_at) {
        return json({ ok: false, error: "No upcoming charge" }, { status: 400 });
      }
      const next = addInterval(contract.next_billing_at, {
        interval: contract.interval,
        intervalCount: contract.interval_count,
      });
      await updateContractStatus(context, {
        shop: session.shop,
        shopifyContractId: id,
        status: contract.status,
        nextBillingAt: next,
        nowMs,
      });
      await recordAction(context, {
        shop: session.shop,
        shopifyContractId: id,
        action: "skip",
        actor: "customer",
        newState: { nextBillingAt: next },
        nowMs,
      });
      return json({ ok: true });
    }
    case "cancel": {
      await updateContractStatus(context, {
        shop: session.shop,
        shopifyContractId: id,
        status: "cancelled",
        cancelledAt: nowMs,
        nowMs,
      });
      await recordAction(context, {
        shop: session.shop,
        shopifyContractId: id,
        action: "cancel",
        actor: "customer",
        nowMs,
      });
      return json({ ok: true });
    }
    case "change_frequency": {
      const interval = String(form.get("interval") ?? "month") as Interval;
      const intervalCount = Math.max(
        1,
        Number.parseInt(String(form.get("intervalCount") ?? "1"), 10) || 1,
      );
      await updateContractStatus(context, {
        shop: session.shop,
        shopifyContractId: id,
        status: contract.status,
        intervalCount,
        nowMs,
      });
      await recordAction(context, {
        shop: session.shop,
        shopifyContractId: id,
        action: "change_frequency",
        actor: "customer",
        newState: { interval, intervalCount },
        nowMs,
      });
      return json({ ok: true });
    }
    case "swap": {
      const variantId = String(form.get("variantId") ?? "");
      const title = String(form.get("title") ?? "");
      if (!variantId || !title) {
        return json({ ok: false, error: "Missing variant" }, { status: 400 });
      }
      let lines: Array<{ title: string; variantId: string; quantity: number; pricePerCents: number }> = [];
      try {
        lines = JSON.parse(contract.line_items_json);
      } catch {
        lines = [];
      }
      const next = lines.map((l) =>
        l.quantity > 0 ? { ...l, variantId, title } : l,
      );
      await updateContractStatus(context, {
        shop: session.shop,
        shopifyContractId: id,
        status: contract.status,
        lineItems: next,
        nowMs,
      });
      await recordAction(context, {
        shop: session.shop,
        shopifyContractId: id,
        action: "swap",
        actor: "customer",
        oldState: { lines },
        newState: { lines: next },
        nowMs,
      });
      return json({ ok: true });
    }
    case "signout": {
      return redirect("/apps/subscriptions", {
        headers: { "Set-Cookie": clearPortalCookie() },
      });
    }
    default:
      return json({ ok: false, error: "unknown intent" }, { status: 400 });
  }
}

function formatCents(cents: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(
      cents / 100,
    );
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

export default function Portal() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  if (!data.ok) {
    const message =
      data.reason === "expired"
        ? "That link has expired."
        : data.reason === "already_used"
          ? "That link was already used."
          : data.reason === "not_found"
            ? "That link isn't valid."
            : "Sign in first.";
    return (
      <main style={pageStyle}>
        <style dangerouslySetInnerHTML={{ __html: STYLES }} />
        <div className="sm-card" style={cardStyle}>
          <h1 style={headingStyle}>Sign in to continue</h1>
          <p style={subtitleStyle}>{message}</p>
          <a href={data.shop ? `/apps/subscriptions?shop=${encodeURIComponent(data.shop)}` : "/apps/subscriptions"} style={primaryLinkStyle}>
            Request a new link
          </a>
        </div>
      </main>
    );
  }

  const submit = (intent: string, contract: string, extra: Record<string, string> = {}) => {
    const fd = new FormData();
    fd.set("intent", intent);
    fd.set("contract", contract);
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    fetcher.submit(fd, { method: "post" });
  };

  return (
    <main style={pageStyle}>
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      <div className="sm-portal" style={wrapStyle}>
        <header style={headerStyle}>
          <h1 style={headingStyle}>Your subscriptions</h1>
          <p style={subtitleStyle}>Signed in as {data.customerEmail}.</p>
          <Form method="post">
            <input type="hidden" name="intent" value="signout" />
            <input type="hidden" name="contract" value="signout" />
            <button type="submit" style={linkButtonStyle}>Sign out</button>
          </Form>
        </header>
        {data.contracts.length === 0 ? (
          <div className="sm-card" style={cardStyle}>
            <p>You don't have any subscriptions yet.</p>
          </div>
        ) : (
          <ul style={listStyle}>
            {data.contracts.map((c) => (
              <li key={c.shopify_contract_id} className="sm-card" style={cardStyle}>
                <ContractCard
                  contract={c}
                  onPause={() => submit("pause", c.shopify_contract_id)}
                  onReactivate={() => submit("reactivate", c.shopify_contract_id)}
                  onSkip={() => submit("skip", c.shopify_contract_id)}
                  onCancel={() => submit("cancel", c.shopify_contract_id)}
                  onChangeFrequency={(interval, count) =>
                    submit("change_frequency", c.shopify_contract_id, {
                      interval,
                      intervalCount: String(count),
                    })
                  }
                  onSwap={(variantId, title) =>
                    submit("swap", c.shopify_contract_id, { variantId, title })
                  }
                  busy={fetcher.state !== "idle"}
                />
              </li>
            ))}
          </ul>
        )}
        {(() => {
          const fd = fetcher.data as { ok: boolean; error?: string } | undefined;
          if (!fd || fd.ok) return null;
          return (
            <div role="alert" style={errorStyle}>{fd.error ?? "Action failed"}</div>
          );
        })()}
      </div>
    </main>
  );
}

function ContractCard({
  contract,
  onPause,
  onReactivate,
  onSkip,
  onCancel,
  onChangeFrequency,
  onSwap,
  busy,
}: {
  contract: ContractRow;
  onPause: () => void;
  onReactivate: () => void;
  onSkip: () => void;
  onCancel: () => void;
  onChangeFrequency: (interval: Interval, count: number) => void;
  onSwap: (variantId: string, title: string) => void;
  busy: boolean;
}) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
        <h2 style={{ margin: 0, fontSize: "1.15rem" }}>{summarise(contract)}</h2>
        <span style={statusStyle(contract.status)}>{contract.status}</span>
      </div>
      <p style={subtitleStyle}>
        {formatCents(contract.amount_cents, contract.currency)} · Every {contract.interval_count} {contract.interval}
        {contract.interval_count > 1 ? "s" : ""}
      </p>
      <p style={subtitleStyle}>
        Next charge:{" "}
        {contract.next_billing_at
          ? new Intl.DateTimeFormat(undefined, { dateStyle: "long" }).format(
              new Date(contract.next_billing_at),
            )
          : "—"}
      </p>
      <div style={actionsRowStyle}>
        {contract.status === "active" ? (
          <button onClick={onPause} disabled={busy} style={primaryButtonStyle}>Pause</button>
        ) : contract.status === "paused" ? (
          <button onClick={onReactivate} disabled={busy} style={primaryButtonStyle}>Reactivate</button>
        ) : null}
        {contract.status !== "cancelled" && contract.next_billing_at ? (
          <button onClick={onSkip} disabled={busy} style={secondaryButtonStyle}>Skip next</button>
        ) : null}
        {contract.status !== "cancelled" ? (
          <button
            onClick={() => {
              if (typeof window !== "undefined" && window.confirm("Cancel this subscription?")) onCancel();
            }}
            disabled={busy}
            style={dangerButtonStyle}
          >
            Cancel
          </button>
        ) : null}
      </div>
      <details style={{ marginTop: 16 }}>
        <summary style={detailsSummaryStyle}>Change frequency</summary>
        <FrequencyForm
          initial={{ interval: contract.interval, intervalCount: contract.interval_count }}
          busy={busy}
          onApply={onChangeFrequency}
        />
      </details>
      <details style={{ marginTop: 8 }}>
        <summary style={detailsSummaryStyle}>Swap product</summary>
        <SwapForm busy={busy} onApply={onSwap} />
      </details>
    </div>
  );
}

function FrequencyForm({
  initial,
  busy,
  onApply,
}: {
  initial: { interval: Interval; intervalCount: number };
  busy: boolean;
  onApply: (i: Interval, n: number) => void;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        onApply(
          (fd.get("interval") as Interval) || "month",
          Math.max(1, Number.parseInt(String(fd.get("intervalCount") ?? "1"), 10) || 1),
        );
      }}
      style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}
    >
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={labelStyle}>Interval</span>
        <select name="interval" defaultValue={initial.interval} style={selectStyle}>
          <option value="day">Day</option>
          <option value="week">Week</option>
          <option value="month">Month</option>
          <option value="year">Year</option>
        </select>
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={labelStyle}>Every</span>
        <input
          name="intervalCount"
          type="number"
          min={1}
          max={52}
          defaultValue={initial.intervalCount}
          style={{ ...inputStyle, width: 80 }}
        />
      </label>
      <button type="submit" disabled={busy} style={{ ...primaryButtonStyle, alignSelf: "flex-end" }}>
        Apply
      </button>
    </form>
  );
}

function SwapForm({ busy, onApply }: { busy: boolean; onApply: (variantId: string, title: string) => void }) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const variantId = String(fd.get("variantId") ?? "").trim();
        const title = String(fd.get("title") ?? "").trim();
        if (!variantId || !title) return;
        onApply(variantId, title);
      }}
      style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}
    >
      <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
        <span style={labelStyle}>New variant ID</span>
        <input
          name="variantId"
          required
          placeholder="gid://shopify/ProductVariant/123…"
          style={inputStyle}
        />
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
        <span style={labelStyle}>Display name</span>
        <input name="title" required placeholder="Decaf Roast" style={inputStyle} />
      </label>
      <button type="submit" disabled={busy} style={{ ...primaryButtonStyle, alignSelf: "flex-end" }}>
        Swap
      </button>
    </form>
  );
}

function summarise(c: ContractRow): string {
  try {
    const items = JSON.parse(c.line_items_json) as Array<{ title?: string; quantity?: number }>;
    if (Array.isArray(items) && items.length > 0) {
      return items.map((i) => `${i.title ?? "Item"} × ${i.quantity ?? 1}`).join(", ");
    }
  } catch {
    // fall through
  }
  return "Subscription";
}

function statusStyle(status: ContractRow["status"]): React.CSSProperties {
  const map: Record<ContractRow["status"], { bg: string; fg: string }> = {
    active: { bg: "rgba(0,128,96,0.1)", fg: "rgb(0,96,72)" },
    paused: { bg: "rgba(255,165,0,0.12)", fg: "rgb(170,90,0)" },
    failed: { bg: "rgba(214,68,68,0.1)", fg: "rgb(180,40,40)" },
    cancelled: { bg: "rgba(0,0,0,0.05)", fg: "rgb(80,80,80)" },
    expired: { bg: "rgba(0,0,0,0.05)", fg: "rgb(80,80,80)" },
  };
  const s = map[status];
  return {
    background: s.bg,
    color: s.fg,
    padding: "4px 10px",
    borderRadius: 999,
    fontSize: "0.75rem",
    fontWeight: 600,
    textTransform: "uppercase",
  };
}

const STYLES = `
  body { margin: 0; }
  .sm-portal { max-width: 720px; margin: 0 auto; padding: 24px; }
  .sm-card { padding: 20px; }
  @media (max-width: 480px) {
    .sm-portal { padding: 16px; }
    .sm-card { padding: 16px !important; }
  }
  button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--color-button, #111); outline-offset: 2px; }
`;

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  background: "var(--color-background, #fafafa)",
  color: "var(--color-foreground, #111)",
  fontFamily: "var(--font-body-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif)",
};
const wrapStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 16 };
const headerStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4 };
const cardStyle: React.CSSProperties = {
  background: "#fff",
  borderRadius: 12,
  boxShadow: "0 2px 12px rgba(0,0,0,0.05)",
};
const listStyle: React.CSSProperties = { listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 16 };
const headingStyle: React.CSSProperties = { margin: 0, fontSize: "1.5rem", fontWeight: 700 };
const subtitleStyle: React.CSSProperties = { margin: "4px 0", color: "rgba(0,0,0,0.6)", fontSize: "0.95rem" };
const labelStyle: React.CSSProperties = { fontSize: "0.8rem", fontWeight: 600 };
const inputStyle: React.CSSProperties = {
  padding: "12px",
  border: "1px solid #ddd",
  borderRadius: 8,
  fontFamily: "inherit",
  fontSize: "0.95rem",
  width: "100%",
  boxSizing: "border-box",
};
const selectStyle: React.CSSProperties = { ...inputStyle };
const actionsRowStyle: React.CSSProperties = { display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" };
const primaryButtonStyle: React.CSSProperties = {
  padding: "12px 18px",
  fontSize: "0.95rem",
  fontWeight: 600,
  color: "var(--color-button-text, #fff)",
  background: "var(--color-button, #111)",
  border: 0,
  borderRadius: 8,
  cursor: "pointer",
};
const secondaryButtonStyle: React.CSSProperties = {
  ...primaryButtonStyle,
  background: "transparent",
  color: "var(--color-foreground, #111)",
  border: "1px solid #ddd",
};
const dangerButtonStyle: React.CSSProperties = {
  ...primaryButtonStyle,
  background: "transparent",
  color: "rgb(180,40,40)",
  border: "1px solid rgba(214,68,68,0.4)",
};
const linkButtonStyle: React.CSSProperties = {
  background: "transparent",
  color: "rgba(0,0,0,0.6)",
  border: 0,
  padding: 0,
  marginTop: 4,
  fontSize: "0.85rem",
  cursor: "pointer",
  textDecoration: "underline",
};
const detailsSummaryStyle: React.CSSProperties = { cursor: "pointer", color: "rgba(0,0,0,0.6)", fontSize: "0.9rem" };
const primaryLinkStyle: React.CSSProperties = {
  display: "inline-block",
  marginTop: 12,
  padding: "12px 18px",
  borderRadius: 8,
  color: "var(--color-button-text, #fff)",
  background: "var(--color-button, #111)",
  textDecoration: "none",
  fontWeight: 600,
};
const errorStyle: React.CSSProperties = {
  padding: 12,
  borderRadius: 8,
  background: "rgba(214,68,68,0.08)",
  color: "rgb(180,40,40)",
  fontSize: "0.9rem",
};
