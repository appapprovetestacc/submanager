// MRR / Active / Paused / Churn rollup math. Pure functions — caller
// reads the relevant contract rows from db.server.ts and passes them in.

import { monthlyValueCents, type Frequency } from "./frequency";

export type ContractStatus = "active" | "paused" | "cancelled" | "expired" | "failed";

export interface ContractSummary {
  status: ContractStatus;
  amountCents: number;
  frequency: Frequency;
  /** Active subscription start timestamp (ms). Used for churn calc. */
  createdAt: number;
  /** When the contract was cancelled (ms). Required for churn window. */
  cancelledAt: number | null;
}

export interface DashboardRollup {
  mrrCents: number;
  activeCount: number;
  pausedCount: number;
  cancelledCount: number;
  failedCount: number;
  /** Churn-rate over the past 30 days, as a 0–1 ratio. */
  churn30d: number;
}

const THIRTY_DAYS_MS = 30 * 86_400_000;

export function rollupDashboard(
  contracts: ContractSummary[],
  nowMs: number,
): DashboardRollup {
  let mrrCents = 0;
  let activeCount = 0;
  let pausedCount = 0;
  let cancelledCount = 0;
  let failedCount = 0;

  // Churn denominator: contracts that were ACTIVE at the start of the
  // 30-day window (= currently active + currently cancelled-within-window).
  const windowStart = nowMs - THIRTY_DAYS_MS;
  let cancelledInWindow = 0;
  let activeAtWindowStart = 0;

  for (const c of contracts) {
    switch (c.status) {
      case "active":
        activeCount++;
        activeAtWindowStart++;
        mrrCents += monthlyValueCents(c.amountCents, c.frequency, "active");
        break;
      case "paused":
        pausedCount++;
        // Paused contracts are still on the books → count toward MRR
        // committed revenue. Skio convention.
        mrrCents += monthlyValueCents(c.amountCents, c.frequency, "paused");
        break;
      case "cancelled":
        cancelledCount++;
        if (c.cancelledAt !== null && c.cancelledAt >= windowStart) {
          cancelledInWindow++;
          // Was active at window start if it was cancelled INSIDE the window
          activeAtWindowStart++;
        }
        break;
      case "expired":
        cancelledCount++;
        break;
      case "failed":
        failedCount++;
        // Failed dunning still counts as on-the-books until operator cancels
        mrrCents += monthlyValueCents(c.amountCents, c.frequency, "active");
        break;
    }
  }

  const churn30d = activeAtWindowStart > 0 ? cancelledInWindow / activeAtWindowStart : 0;

  return {
    mrrCents,
    activeCount,
    pausedCount,
    cancelledCount,
    failedCount,
    churn30d,
  };
}

export function formatChurnPct(churn: number): string {
  return `${(churn * 100).toFixed(1)}%`;
}
