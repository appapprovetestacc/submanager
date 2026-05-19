// SubManager-specific sendMail wrapper. Honours DRY_RUN_EMAILS=1 so
// the renewal-reminder cron can be validated end-to-end on a dev store
// without actually firing Resend. Wraps app/lib/mail.server.ts.

import type { AppLoadContext } from "@remix-run/cloudflare";
import type { Env } from "../../../load-context";
import { sendMail, type SendMailResult } from "../mail.server";

export interface SendSubscriptionEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Optional tags for Resend analytics. */
  tags?: Array<{ name: string; value: string }>;
}

function envOf(context: AppLoadContext): Env {
  return (context.cloudflare?.env ?? {}) as Env;
}

export async function sendSubscriptionEmail(
  context: AppLoadContext,
  input: SendSubscriptionEmailInput,
): Promise<SendMailResult> {
  const env = envOf(context);
  if (env.DRY_RUN_EMAILS === "1") {
    console.log(
      `[mail:dry-run] to=${input.to} subject=${JSON.stringify(input.subject)}`,
    );
    return { ok: true, via: "byok", id: "dry-run-" + Date.now() };
  }
  return sendMail(context, {
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text,
    ...(input.tags ? { tags: input.tags } : {}),
  });
}
