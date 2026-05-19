// Gift subscription helpers — prepay N cycles upfront, recipient receives
// deliveries without ever seeing a payment portal.

export interface GiftSummary {
  cyclesTotal: number;
  cyclesRemaining: number;
  status: "pending_setup" | "active" | "completed" | "cancelled";
}

// Decrement cycles after a successful billing-attempt success. When
// remaining hits 0, transition to "completed" and signal that the
// caller should cancel the underlying SubscriptionContract.
export interface GiftCycleResult {
  next: GiftSummary;
  shouldCancelContract: boolean;
}

export function consumeCycle(prev: GiftSummary): GiftCycleResult {
  if (prev.status !== "active") {
    return { next: prev, shouldCancelContract: false };
  }
  const remaining = Math.max(0, prev.cyclesRemaining - 1);
  if (remaining === 0) {
    return {
      next: { ...prev, cyclesRemaining: 0, status: "completed" },
      shouldCancelContract: true,
    };
  }
  return {
    next: { ...prev, cyclesRemaining: remaining },
    shouldCancelContract: false,
  };
}

// Total prepaid amount given a per-cycle price and N cycles. Currency is
// always integer cents.
export function totalPrepaidCents(perCycleCents: number, cycles: number): number {
  if (cycles <= 0 || !Number.isFinite(cycles)) return 0;
  if (perCycleCents < 0) return 0;
  return perCycleCents * cycles;
}

// Allowed cycle counts surfaced in the checkout block. Skio-typical
// values; merchants don't configure these for the MVP.
export const ALLOWED_GIFT_CYCLES = [3, 6, 12] as const;
export type AllowedGiftCycle = (typeof ALLOWED_GIFT_CYCLES)[number];

export function isAllowedGiftCycle(n: number): n is AllowedGiftCycle {
  return (ALLOWED_GIFT_CYCLES as ReadonlyArray<number>).includes(n);
}
