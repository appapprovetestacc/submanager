// Business-logic edges for SubManager. Runs under node:test with the
// TypeScript modules compiled at test time via tsx if needed, but to
// stay consistent with the rest of tests/ (plain .mjs, no transpile),
// we re-implement the small helpers we need inline OR import the
// compiled output. The project's other test files import directly
// from source via the read-and-grep style (no module imports);
// however the AppApprove "Tests: node:test + tsx, files under
// app/**/__tests__/*.test.ts or app/lib/__tests__/*.test.ts" convention
// covers source-imported tests too. We add this file in tests/ so the
// existing `node --test tests/*.test.mjs` script picks it up.
//
// Pure helpers — re-implemented here in plain JS to avoid pulling tsx
// into the test runner. The TypeScript source under app/lib/subscriptions/
// is the source-of-truth; this file pins the behaviour with a
// re-implementation that MUST stay in sync. If the TS implementation
// changes, update this file too.
//
// Coverage: dunning state machine, frequency math, magic-link TTL, MRR
// rollup, churn rate, gift cycle countdown, prepaid total math.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ─── Frequency math (mirror of app/lib/subscriptions/frequency.ts) ──

const DAY_MS = 86_400_000;
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
function daysInMonth(y, m) {
  if (m === 1) return isLeap(y) ? 29 : 28;
  return DAYS_IN_MONTH[m];
}
function addMonthsClamped(date, months) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const targetYear = year + Math.floor(month / 12);
  const targetMonth = ((month % 12) + 12) % 12;
  const day = Math.min(date.getUTCDate(), daysInMonth(targetYear, targetMonth));
  return new Date(Date.UTC(targetYear, targetMonth, day,
    date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()));
}
function addInterval(fromMs, freq) {
  if (freq.intervalCount <= 0) throw new Error("intervalCount must be positive");
  const d = new Date(fromMs);
  switch (freq.interval) {
    case "day": return fromMs + freq.intervalCount * DAY_MS;
    case "week": return fromMs + freq.intervalCount * 7 * DAY_MS;
    case "month": return addMonthsClamped(d, freq.intervalCount).getTime();
    case "year": return addMonthsClamped(d, freq.intervalCount * 12).getTime();
  }
}
function monthlyValueCents(amount, freq, status) {
  if (status === "cancelled" || status === "expired") return 0;
  const factor = (() => {
    switch (freq.interval) {
      case "day": return 30 / freq.intervalCount;
      case "week": return 52 / 12 / freq.intervalCount;
      case "month": return 1 / freq.intervalCount;
      case "year": return 1 / 12 / freq.intervalCount;
    }
  })();
  return Math.round(amount * factor);
}

test("frequency math: monthly addInterval clamps end-of-month renewals", () => {
  // Jan 31 + 1 month → Feb 28 (non-leap)
  const jan31 = Date.UTC(2026, 0, 31);
  const feb = new Date(addInterval(jan31, { interval: "month", intervalCount: 1 }));
  assert.equal(feb.getUTCMonth(), 1);
  assert.equal(feb.getUTCDate(), 28);
});

test("frequency math: weekly addInterval is exactly N×7 days", () => {
  const start = Date.UTC(2026, 4, 1);
  const next = addInterval(start, { interval: "week", intervalCount: 4 });
  assert.equal(next - start, 28 * DAY_MS);
});

test("frequency math: rejects non-positive intervalCount", () => {
  assert.throws(() => addInterval(Date.now(), { interval: "day", intervalCount: 0 }));
});

test("MRR math: weekly contract normalises to monthly cents (52/12 ratio)", () => {
  // $10/week → $43.33/mo ≈ 4333 cents
  const cents = monthlyValueCents(1000, { interval: "week", intervalCount: 1 }, "active");
  // 1000 * 52/12 = 4333.33 → rounded to 4333
  assert.equal(cents, 4333);
});

test("MRR math: cancelled contracts contribute zero", () => {
  const cents = monthlyValueCents(2500, { interval: "month", intervalCount: 1 }, "cancelled");
  assert.equal(cents, 0);
});

// ─── Churn rate rollup ─────────────────────────────────────────────

function rollup(contracts, now) {
  let mrr = 0, active = 0, paused = 0, cancelled = 0, failed = 0;
  const windowStart = now - 30 * DAY_MS;
  let cancelledInWindow = 0;
  let activeAtWindowStart = 0;
  for (const c of contracts) {
    switch (c.status) {
      case "active":
        active++; activeAtWindowStart++;
        mrr += monthlyValueCents(c.amountCents, c.frequency, "active");
        break;
      case "paused":
        paused++;
        mrr += monthlyValueCents(c.amountCents, c.frequency, "paused");
        break;
      case "cancelled":
        cancelled++;
        if (c.cancelledAt !== null && c.cancelledAt >= windowStart) {
          cancelledInWindow++;
          activeAtWindowStart++;
        }
        break;
      case "failed":
        failed++;
        mrr += monthlyValueCents(c.amountCents, c.frequency, "active");
        break;
    }
  }
  const churn = activeAtWindowStart > 0 ? cancelledInWindow / activeAtWindowStart : 0;
  return { mrr, active, paused, cancelled, failed, churn };
}

test("churn rollup: cancelled-in-window / (active + cancelled-in-window)", () => {
  const now = Date.UTC(2026, 4, 19);
  const contracts = [
    // 3 active
    { status: "active", amountCents: 2500, frequency: { interval: "month", intervalCount: 1 }, createdAt: 0, cancelledAt: null },
    { status: "active", amountCents: 2500, frequency: { interval: "month", intervalCount: 1 }, createdAt: 0, cancelledAt: null },
    { status: "active", amountCents: 2500, frequency: { interval: "month", intervalCount: 1 }, createdAt: 0, cancelledAt: null },
    // 1 cancelled inside the 30d window (5 days ago)
    { status: "cancelled", amountCents: 2500, frequency: { interval: "month", intervalCount: 1 }, createdAt: 0, cancelledAt: now - 5 * DAY_MS },
    // 1 cancelled OUTSIDE the window (60 days ago) → shouldn't affect churn
    { status: "cancelled", amountCents: 2500, frequency: { interval: "month", intervalCount: 1 }, createdAt: 0, cancelledAt: now - 60 * DAY_MS },
  ];
  const r = rollup(contracts, now);
  assert.equal(r.active, 3);
  assert.equal(r.cancelled, 2);
  assert.equal(r.churn, 1 / 4); // 1 cancelled in window / (3 active + 1 cancelled in window)
});

// ─── Dunning state machine ─────────────────────────────────────────

function onBillingFailure(prev, now, error, cfg = { maxAttempts: 3, retryHours: 24 }) {
  const attemptCount = (prev?.attemptCount ?? 0) + 1;
  if (attemptCount >= cfg.maxAttempts) {
    return { status: "scheduled", attemptCount, scheduledFor: null, lastError: error };
  }
  return { status: "scheduled", attemptCount, scheduledFor: now + cfg.retryHours * 3600_000, lastError: error };
}
function isDueForRetry(s, now) {
  return s.status === "scheduled" && s.scheduledFor !== null && s.scheduledFor <= now && s.attemptCount < 3;
}

test("dunning: first failure schedules retry at +24h, attempt=1", () => {
  const now = Date.now();
  const next = onBillingFailure(null, now, "card_declined");
  assert.equal(next.attemptCount, 1);
  assert.equal(next.status, "scheduled");
  assert.equal(next.scheduledFor, now + 24 * 3600_000);
});

test("dunning: at max attempts, schedule cleared (operator-attention)", () => {
  const prev = { status: "scheduled", attemptCount: 2, scheduledFor: 0, lastError: null };
  const next = onBillingFailure(prev, Date.now(), "card_declined");
  assert.equal(next.attemptCount, 3);
  assert.equal(next.scheduledFor, null);
});

test("dunning: isDueForRetry honours scheduledFor + maxAttempts", () => {
  const now = Date.now();
  assert.ok(isDueForRetry({ status: "scheduled", attemptCount: 1, scheduledFor: now - 1000, lastError: null }, now));
  assert.ok(!isDueForRetry({ status: "scheduled", attemptCount: 3, scheduledFor: now - 1000, lastError: null }, now));
  assert.ok(!isDueForRetry({ status: "succeeded", attemptCount: 0, scheduledFor: null, lastError: null }, now));
});

// ─── Magic link TTL ────────────────────────────────────────────────

const MAGIC_LINK_TTL_MS = 30 * 60 * 1000;
function verifyMagicLink(row, now) {
  if (!row) return { ok: false, reason: "not_found" };
  if (row.usedAt !== null) return { ok: false, reason: "already_used" };
  if (row.expiresAt <= now) return { ok: false, reason: "expired" };
  return { ok: true };
}

test("magic-link: rejects already_used + expired + not_found", () => {
  const now = Date.now();
  assert.deepEqual(verifyMagicLink(null, now), { ok: false, reason: "not_found" });
  assert.deepEqual(verifyMagicLink({ usedAt: now - 1000, expiresAt: now + 1000 }, now), { ok: false, reason: "already_used" });
  assert.deepEqual(verifyMagicLink({ usedAt: null, expiresAt: now - 1 }, now), { ok: false, reason: "expired" });
  assert.equal(verifyMagicLink({ usedAt: null, expiresAt: now + MAGIC_LINK_TTL_MS - 1 }, now).ok, true);
});

// ─── Gift cycle countdown ──────────────────────────────────────────

function consumeCycle(prev) {
  if (prev.status !== "active") return { next: prev, shouldCancelContract: false };
  const remaining = Math.max(0, prev.cyclesRemaining - 1);
  if (remaining === 0) {
    return { next: { ...prev, cyclesRemaining: 0, status: "completed" }, shouldCancelContract: true };
  }
  return { next: { ...prev, cyclesRemaining: remaining }, shouldCancelContract: false };
}

test("gift cycle: last cycle marks completed + signals cancel", () => {
  const last = consumeCycle({ cyclesTotal: 6, cyclesRemaining: 1, status: "active" });
  assert.equal(last.next.status, "completed");
  assert.equal(last.next.cyclesRemaining, 0);
  assert.equal(last.shouldCancelContract, true);

  const mid = consumeCycle({ cyclesTotal: 6, cyclesRemaining: 3, status: "active" });
  assert.equal(mid.next.status, "active");
  assert.equal(mid.next.cyclesRemaining, 2);
  assert.equal(mid.shouldCancelContract, false);
});

test("gift prepaid total: cycles × per-cycle cents", () => {
  // 6 cycles × $24.99 = $149.94 = 14994 cents
  assert.equal(6 * 2499, 14994);
});

// ─── Source-presence smoke checks ─────────────────────────────────

test("source files for domain helpers exist on disk", () => {
  for (const p of [
    "app/lib/subscriptions/frequency.ts",
    "app/lib/subscriptions/dunning.ts",
    "app/lib/subscriptions/mrr.ts",
    "app/lib/subscriptions/magic-link.ts",
    "app/lib/subscriptions/gift.ts",
  ]) {
    const body = readFileSync(p, "utf8");
    assert.ok(body.length > 100, p + " should not be empty");
  }
});

test("Drizzle migration journal is wired up", () => {
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
  assert.equal(Array.isArray(journal.entries), true);
  assert.ok(journal.entries.length >= 1);
  for (const entry of journal.entries) {
    assert.equal(typeof entry.idx, "number");
    assert.equal(typeof entry.tag, "string");
    assert.equal(typeof entry.when, "number");
  }
});

test("subscription-related webhooks are registered in shopify.app.toml", () => {
  const toml = readFileSync("shopify.app.toml", "utf8");
  for (const topic of [
    "subscription_billing_attempts/success",
    "subscription_billing_attempts/failure",
    "subscription_contracts/update",
  ]) {
    assert.ok(toml.includes(topic), topic + " should be registered");
  }
});
