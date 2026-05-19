// Frequency / billing-date math for subscription contracts.
// All times in ms-since-epoch (Date.now() compatible). Pure functions —
// no DB, no Date.now() reads; callers pass `now` explicitly so tests
// stay deterministic.

export type Interval = "day" | "week" | "month" | "year";

export interface Frequency {
  interval: Interval;
  intervalCount: number;
}

export const DAY_MS = 86_400_000;

const isLeap = (year: number): boolean =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysInMonth(year: number, monthZeroIndexed: number): number {
  if (monthZeroIndexed === 1) return isLeap(year) ? 29 : 28;
  return DAYS_IN_MONTH[monthZeroIndexed]!;
}

// Add months while clamping to the last valid day. Skio-style: a contract
// renewing on Jan 31 should renew on Feb 28/29, not slide to Mar 3.
function addMonthsClamped(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const targetYear = year + Math.floor(month / 12);
  const targetMonth = ((month % 12) + 12) % 12;
  const day = Math.min(date.getUTCDate(), daysInMonth(targetYear, targetMonth));
  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      day,
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
}

export function addInterval(fromMs: number, freq: Frequency): number {
  if (freq.intervalCount <= 0 || !Number.isFinite(freq.intervalCount)) {
    throw new Error("intervalCount must be a positive integer");
  }
  const d = new Date(fromMs);
  switch (freq.interval) {
    case "day":
      return fromMs + freq.intervalCount * DAY_MS;
    case "week":
      return fromMs + freq.intervalCount * 7 * DAY_MS;
    case "month":
      return addMonthsClamped(d, freq.intervalCount).getTime();
    case "year":
      return addMonthsClamped(d, freq.intervalCount * 12).getTime();
  }
}

// Skip one cycle: return the next-billing-at AFTER one frequency step.
export function nextAfterSkip(currentNextMs: number, freq: Frequency): number {
  return addInterval(currentNextMs, freq);
}

// Resume from pause: choose max(originally scheduled next billing,
// pause-end time). Skio pauses to a fixed date, then resumes on that
// date if it's still in the future.
export function resumeBilling(
  originallyNextMs: number,
  pauseUntilMs: number,
  nowMs: number,
): number {
  const target = Math.max(originallyNextMs, pauseUntilMs);
  // If both are in the past (e.g. customer reactivated after the
  // pause window expired), schedule for "now + 1 day" so the merchant
  // has time to update billing details before the first auto-charge.
  if (target <= nowMs) return nowMs + DAY_MS;
  return target;
}

// Convert a frequency to a human-readable string. English-only by
// AppApprove convention.
export function humanFrequency(freq: Frequency): string {
  const unit = (() => {
    switch (freq.interval) {
      case "day":
        return "day";
      case "week":
        return "week";
      case "month":
        return "month";
      case "year":
        return "year";
    }
  })();
  if (freq.intervalCount === 1) return `Every ${unit}`;
  return `Every ${freq.intervalCount} ${unit}s`;
}

// Compute MRR contribution of one contract in cents (monthly normalised).
// - daily: amount × 30
// - weekly: amount × (52 / 12)
// - monthly: amount × (1 / intervalCount) — every 3 months → /3
// - yearly: amount × (1 / 12 / intervalCount)
// Returns 0 if cancelled/expired; paused contracts still count (Skio
// convention: pause is reversible, MRR represents committed revenue).
export function monthlyValueCents(
  amountCents: number,
  freq: Frequency,
  status: "active" | "paused" | "cancelled" | "expired" | "failed",
): number {
  if (status === "cancelled" || status === "expired") return 0;
  const perMonthFactor = (() => {
    switch (freq.interval) {
      case "day":
        return 30 / freq.intervalCount;
      case "week":
        return 52 / 12 / freq.intervalCount;
      case "month":
        return 1 / freq.intervalCount;
      case "year":
        return 1 / 12 / freq.intervalCount;
    }
  })();
  return Math.round(amountCents * perMonthFactor);
}
