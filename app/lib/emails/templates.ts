// Email templates for SubManager. No template engine — plain string
// substitution of {{merge_tag}} into a baseline HTML/text body. Keep
// these readable; merchants commonly fork them.

export interface TemplateInput {
  shopName: string;
  /** Customer-visible name when available, else falls back to email. */
  customerName: string | null;
  /** Currency amount formatted at the caller (e.g. "$24.99"). */
  amountFormatted: string;
  /** Next billing date formatted at the caller. */
  nextBillingFormatted: string;
  /** Magic-link URL — already includes the token. */
  portalUrl: string;
  /** Product summary line: "Roast of the Month × 1" etc. */
  productSummary: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

function greet(input: TemplateInput): string {
  return input.customerName ? `Hi ${escape(input.customerName)},` : "Hi there,";
}

function escape(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function wrap(bodyHtml: string, ctaUrl?: string, ctaLabel?: string): string {
  const cta = ctaUrl
    ? `<p style="margin:24px 0;"><a href="${escape(ctaUrl)}" style="display:inline-block;padding:12px 20px;background:#111;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">${escape(ctaLabel ?? "Manage subscription")}</a></p>`
    : "";
  return `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111;line-height:1.5;">
    ${bodyHtml}
    ${cta}
    <hr style="border:none;border-top:1px solid #eee;margin:32px 0;"/>
    <p style="font-size:12px;color:#666;">You're receiving this because you have an active subscription. Manage your preferences at any time from the portal.</p>
  </body></html>`;
}

// ─── Renewal reminder (3 days before charge) ───────────────────────

export function renderRenewalReminder(input: TemplateInput): RenderedEmail {
  const subject = `Your ${escape(input.shopName)} order ships in 3 days`;
  const html = wrap(
    `<h2 style="margin:0 0 16px;">${greet(input)}</h2>
     <p>This is a reminder that your subscription with <strong>${escape(input.shopName)}</strong> will renew on <strong>${escape(input.nextBillingFormatted)}</strong>.</p>
     <p><strong>Order summary</strong><br/>${escape(input.productSummary)}<br/>${escape(input.amountFormatted)}</p>
     <p>Need to skip, swap, or pause? Use the portal — no login required.</p>`,
    input.portalUrl,
    "Manage subscription",
  );
  const text = `${greet(input)}\n\nYour ${input.shopName} subscription renews on ${input.nextBillingFormatted}.\n\nOrder: ${input.productSummary}\nAmount: ${input.amountFormatted}\n\nManage: ${input.portalUrl}\n`;
  return { subject, html, text };
}

// ─── Dunning retry emails ──────────────────────────────────────────

export function renderDunning(
  input: TemplateInput,
  attempt: 1 | 2 | 3 | "final",
): RenderedEmail {
  const subject =
    attempt === "final"
      ? `Action needed: subscription on hold at ${escape(input.shopName)}`
      : `We couldn't process your subscription payment (attempt ${attempt})`;
  const bodyIntro =
    attempt === "final"
      ? `We tried to renew your subscription a few times but each attempt was declined. Your subscription is on hold until you update your payment method.`
      : `We tried to charge ${escape(input.amountFormatted)} for your subscription with ${escape(input.shopName)} but the payment was declined. We'll retry in 24 hours.`;
  const html = wrap(
    `<h2 style="margin:0 0 16px;">${greet(input)}</h2>
     <p>${bodyIntro}</p>
     <p>You can update your payment method or pause the subscription from the portal.</p>`,
    input.portalUrl,
    "Update payment method",
  );
  const text = `${greet(input)}\n\n${bodyIntro}\n\nManage: ${input.portalUrl}\n`;
  return { subject, html, text };
}

// ─── Magic-link email ──────────────────────────────────────────────

export function renderMagicLink(input: {
  shopName: string;
  portalUrl: string;
}): RenderedEmail {
  const subject = `Your ${escape(input.shopName)} subscription portal link`;
  const html = wrap(
    `<h2 style="margin:0 0 16px;">Open your subscription portal</h2>
     <p>Tap the button below to view and manage your subscriptions at ${escape(input.shopName)}.</p>
     <p style="font-size:13px;color:#666;">This link expires in 30 minutes and can only be used once.</p>`,
    input.portalUrl,
    "Open portal",
  );
  const text = `Open your subscription portal:\n${input.portalUrl}\n\nThis link expires in 30 minutes and can only be used once.\n`;
  return { subject, html, text };
}

// ─── State-change notifications ─────────────────────────────────────

export function renderPaused(
  input: TemplateInput,
  resumeFormatted: string,
): RenderedEmail {
  const subject = `Your ${escape(input.shopName)} subscription is paused`;
  const html = wrap(
    `<h2 style="margin:0 0 16px;">${greet(input)}</h2>
     <p>Your subscription is paused. We'll resume billing on <strong>${escape(resumeFormatted)}</strong>.</p>
     <p>You can reactivate any time from the portal.</p>`,
    input.portalUrl,
    "Manage subscription",
  );
  const text = `${greet(input)}\n\nYour subscription is paused. Billing resumes on ${resumeFormatted}.\nManage: ${input.portalUrl}\n`;
  return { subject, html, text };
}

export function renderCancelled(input: TemplateInput): RenderedEmail {
  const subject = `Your ${escape(input.shopName)} subscription has been cancelled`;
  const html = wrap(
    `<h2 style="margin:0 0 16px;">${greet(input)}</h2>
     <p>Your subscription has been cancelled. No further charges will occur.</p>
     <p>Changed your mind? You can restart a subscription from the portal any time.</p>`,
    input.portalUrl,
    "Restart subscription",
  );
  const text = `${greet(input)}\n\nYour subscription has been cancelled.\nRestart: ${input.portalUrl}\n`;
  return { subject, html, text };
}

// ─── Gift recipient: delivery schedule preview ─────────────────────

export interface GiftRecipientInput {
  shopName: string;
  buyerName: string;
  recipientName: string | null;
  cyclesTotal: number;
  cyclesRemaining: number;
  productSummary: string;
  nextDeliveryFormatted: string;
  scheduleUrl: string;
  message: string | null;
}

export function renderGiftRecipient(input: GiftRecipientInput): RenderedEmail {
  const greeting = input.recipientName
    ? `Hi ${escape(input.recipientName)},`
    : "Hi there,";
  const subject = `A gift subscription from ${escape(input.buyerName)} at ${escape(input.shopName)}`;
  const messageBlock = input.message
    ? `<blockquote style="border-left:3px solid #111;padding:8px 16px;margin:16px 0;color:#444;">${escape(input.message)}</blockquote>`
    : "";
  const html = wrap(
    `<h2 style="margin:0 0 16px;">${greeting}</h2>
     <p><strong>${escape(input.buyerName)}</strong> has sent you a gift subscription at <strong>${escape(input.shopName)}</strong> — ${input.cyclesTotal} deliveries, all paid for.</p>
     ${messageBlock}
     <p><strong>What's included</strong><br/>${escape(input.productSummary)}</p>
     <p><strong>First delivery</strong><br/>${escape(input.nextDeliveryFormatted)}</p>
     <p>${input.cyclesRemaining} of ${input.cyclesTotal} deliveries remaining. No payment portal needed — just sit back and enjoy.</p>`,
    input.scheduleUrl,
    "View delivery schedule",
  );
  const text = `${greeting}\n\n${input.buyerName} sent you a gift subscription at ${input.shopName} — ${input.cyclesTotal} deliveries.\n\n${input.message ? `Message: ${input.message}\n\n` : ""}First delivery: ${input.nextDeliveryFormatted}\nView schedule: ${input.scheduleUrl}\n`;
  return { subject, html, text };
}
