import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { displayLimitWindows, type LimitPool } from "@t3tools/shared/usageLimits";

export interface UsageLimitRow {
  readonly id: string;
  readonly label: string;
  readonly remainingPercent: number;
  readonly nextResetAt: number | null;
}

const KIND_ORDER: ReadonlyArray<ServerProviderUsageWindow["kind"]> = [
  "session",
  "weekly",
  "monthly",
  "other",
];

type PoolWindow = LimitPool["windows"][number];

function shortLabel(window: PoolWindow) {
  if (window.kind === "weekly") return "Week";
  if (window.kind === "monthly") return "Month";
  // Pooling drops a session's duration once its weekly window is spent, so read the report.
  const durationMins = window.members
    .map(
      ({ account, window: member }) =>
        account.limits.windows.find((reported) => reported.id === member.id)?.windowDurationMins,
    )
    .find((mins) => mins !== undefined && mins > 0);
  if (window.kind === "session" && durationMins !== undefined) {
    return durationMins % 60 === 0 ? `${durationMins / 60}h` : `${durationMins}m`;
  }
  return window.label;
}

/**
 * One row per window kind, keeping the tightest window so the card stays a few lines tall.
 * Beside session and weekly windows, monthly and other quotas show only once exhausted.
 */
export function usageLimitRows(pool: LimitPool): readonly UsageLimitRow[] {
  const windows = displayLimitWindows(pool);
  const hasRateWindows = windows.some(
    (window) => window.kind === "session" || window.kind === "weekly",
  );
  return KIND_ORDER.flatMap((kind) => {
    const tightest = windows
      .filter((window) => window.kind === kind)
      .toSorted((left, right) => left.remainingPercent - right.remainingPercent)[0];
    if (!tightest) return [];
    const isRateWindow = kind === "session" || kind === "weekly";
    if (hasRateWindows && !isRateWindow && tightest.remainingPercent > 0) return [];
    const nextReset = tightest.resets.toSorted((left, right) => left.at - right.at)[0];
    return [
      {
        id: tightest.id,
        label: shortLabel(tightest),
        remainingPercent: tightest.remainingPercent,
        nextResetAt: nextReset?.at ?? null,
      },
    ];
  });
}
