// Customer portal session.
//
// After a successful magic-link redemption, we set a short-lived
// signed cookie that carries:
//   - shop (myshopify hostname)
//   - customer_id
//   - issued_at (ms)
//
// TTL: 30 minutes. The cookie's signature is keyed by
// SUBSCRIPTIONS_PORTAL_HMAC_SECRET (Worker secret). Token rotates per
// session — issuing a new magic link replaces the cookie.

import type { AppLoadContext } from "@remix-run/cloudflare";
import type { Env } from "../../../load-context";

const COOKIE_NAME = "sm_portal";
export const PORTAL_SESSION_TTL_MS = 30 * 60 * 1000;

export interface PortalSession {
  shop: string;
  customerId: string;
  issuedAt: number;
}

function envOf(context: AppLoadContext): Env {
  return (context.cloudflare?.env ?? {}) as Env;
}

function getHmacSecret(context: AppLoadContext): string {
  const env = envOf(context);
  // Fall back to SHOPIFY_API_SECRET if the dedicated portal HMAC isn't
  // bound yet — keeps the dev story working before secret provisioning
  // has run. Production deploys ship SUBSCRIPTIONS_PORTAL_HMAC_SECRET.
  const secret = env.SUBSCRIPTIONS_PORTAL_HMAC_SECRET ?? env.SHOPIFY_API_SECRET ?? "";
  if (!secret) {
    throw new Error("Portal session secret is not configured.");
  }
  return secret;
}

async function hmacHex(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, enc.encode(payload)),
  );
  let s = "";
  for (let i = 0; i < sig.length; i++) {
    s += sig[i]!.toString(16).padStart(2, "0");
  }
  return s;
}

function b64UrlEncode(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64UrlDecode(s: string): string {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    s.length + ((4 - (s.length % 4)) % 4),
    "=",
  );
  return atob(padded);
}

export async function buildPortalCookie(
  context: AppLoadContext,
  session: PortalSession,
): Promise<string> {
  const secret = getHmacSecret(context);
  const payload = JSON.stringify(session);
  const body = b64UrlEncode(payload);
  const sig = await hmacHex(secret, body);
  const value = `${body}.${sig}`;
  const maxAgeSec = Math.floor(PORTAL_SESSION_TTL_MS / 1000);
  return `${COOKIE_NAME}=${value}; Max-Age=${maxAgeSec}; Path=/apps/subscriptions; HttpOnly; Secure; SameSite=Lax`;
}

export function clearPortalCookie(): string {
  return `${COOKIE_NAME}=; Max-Age=0; Path=/apps/subscriptions; HttpOnly; Secure; SameSite=Lax`;
}

export async function readPortalCookie(
  context: AppLoadContext,
  request: Request,
): Promise<PortalSession | null> {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const found = cookieHeader.split(/;\s*/).find((c) => c.startsWith(`${COOKIE_NAME}=`));
  if (!found) return null;
  const raw = found.slice(COOKIE_NAME.length + 1);
  const idx = raw.lastIndexOf(".");
  if (idx <= 0) return null;
  const body = raw.slice(0, idx);
  const sig = raw.slice(idx + 1);
  const secret = getHmacSecret(context);
  const expected = await hmacHex(secret, body);
  if (expected.length !== sig.length) return null;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  }
  if (mismatch !== 0) return null;
  let parsed: PortalSession;
  try {
    parsed = JSON.parse(b64UrlDecode(body)) as PortalSession;
  } catch {
    return null;
  }
  if (Date.now() - parsed.issuedAt > PORTAL_SESSION_TTL_MS) return null;
  return parsed;
}
