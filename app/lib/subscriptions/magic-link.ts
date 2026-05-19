// Magic-link tokens for customer-portal authentication.
//
// Design:
//   - Token is a 32-byte URL-safe random string (rendered base64url).
//   - Plaintext is emailed via Resend; we never persist it.
//   - We store sha256(token) keyed by token_sha256 → customer_id/expires_at.
//   - TTL: 30 minutes from issue. Single-use: used_at is stamped on
//     first successful verification.
//
// Pure helpers — no DB calls. Caller persists via db.server.ts.

export const MAGIC_LINK_TTL_MS = 30 * 60 * 1000;

export function generateMagicToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export async function hashToken(token: string): Promise<string> {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(token));
  return toHex(new Uint8Array(buf));
}

function toHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) {
    s += b[i]!.toString(16).padStart(2, "0");
  }
  return s;
}

function base64UrlEncode(b: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface MagicLinkRow {
  tokenSha256: string;
  shop: string;
  customerId: string;
  customerEmail: string;
  expiresAt: number;
  usedAt: number | null;
  createdAt: number;
}

export type VerifyResult =
  | { ok: true; row: MagicLinkRow }
  | { ok: false; reason: "not_found" | "expired" | "already_used" };

export function verifyMagicLink(
  row: MagicLinkRow | null,
  nowMs: number,
): VerifyResult {
  if (!row) return { ok: false, reason: "not_found" };
  if (row.usedAt !== null) return { ok: false, reason: "already_used" };
  if (row.expiresAt <= nowMs) return { ok: false, reason: "expired" };
  return { ok: true, row };
}

export interface NewMagicLink {
  plaintext: string;
  hash: string;
  expiresAt: number;
}

export async function issueMagicLink(nowMs: number): Promise<NewMagicLink> {
  const plaintext = generateMagicToken();
  const hash = await hashToken(plaintext);
  return {
    plaintext,
    hash,
    expiresAt: nowMs + MAGIC_LINK_TTL_MS,
  };
}
