// Dunning state machine. Pure functions — caller persists the returned
// next-state through db.server.ts. We deliberately don't auto-terminate
// on N attempts; the MVP brief says: "Do NOT auto-cancel after N failed
// dunning attempts without operator/merchant config — show a dashboard
// alert instead." So failed_terminal is only reached when the merchant
// confirms or when attemptCount > configured max AND retention has
// elapsed.

export type DunningStatus = "pending" | "scheduled" | "succeeded" | "failed_terminal";

export interface DunningState {
  status: DunningStatus;
  attemptCount: number;
  scheduledFor: number | null;
  lastError: string | null;
}

export interface DunningConfig {
  maxAttempts: number; // default 3
  retryHours: number; // default 24
}

export const DEFAULT_DUNNING_CONFIG: DunningConfig = {
  maxAttempts: 3,
  retryHours: 24,
};

// A fresh failure event from Shopify (billing_attempts/failure). Either
// open a new dunning row (attemptCount 1) or escalate an existing one.
export function onBillingFailure(
  prev: DunningState | null,
  nowMs: number,
  error: string,
  config: DunningConfig = DEFAULT_DUNNING_CONFIG,
): DunningState {
  const attemptCount = (prev?.attemptCount ?? 0) + 1;
  const reachedMax = attemptCount >= config.maxAttempts;
  if (reachedMax) {
    // Don't auto-terminate — leave at "scheduled" with a null scheduled_for
    // so the dashboard can flag it. Operator decides whether to retry
    // manually or cancel via the UI.
    return {
      status: "scheduled",
      attemptCount,
      scheduledFor: null,
      lastError: error,
    };
  }
  return {
    status: "scheduled",
    attemptCount,
    scheduledFor: nowMs + config.retryHours * 60 * 60 * 1000,
    lastError: error,
  };
}

// Successful retry (manual or auto). Move to succeeded + clear schedule.
export function onBillingSuccess(prev: DunningState | null): DunningState {
  return {
    status: "succeeded",
    attemptCount: prev?.attemptCount ?? 0,
    scheduledFor: null,
    lastError: null,
  };
}

// Operator-driven terminal state.
export function markTerminal(
  prev: DunningState,
  reason: string = "merchant_cancelled",
): DunningState {
  return {
    status: "failed_terminal",
    attemptCount: prev.attemptCount,
    scheduledFor: null,
    lastError: reason,
  };
}

// Filter: is this row due for an automatic retry now? Used by the
// daily cron.
export function isDueForRetry(state: DunningState, nowMs: number): boolean {
  return (
    state.status === "scheduled" &&
    state.scheduledFor !== null &&
    state.scheduledFor <= nowMs &&
    state.attemptCount < DEFAULT_DUNNING_CONFIG.maxAttempts
  );
}

// Should the admin UI show a "needs attention" banner on the contract?
export function needsOperatorAttention(state: DunningState, config: DunningConfig = DEFAULT_DUNNING_CONFIG): boolean {
  return (
    state.status === "scheduled" &&
    state.attemptCount >= config.maxAttempts &&
    state.scheduledFor === null
  );
}
