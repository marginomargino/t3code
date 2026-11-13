import { ProviderDriverKind, type ServerProviderUsageWindow } from "@t3tools/contracts";
import { collectLimitPools, type LimitAccount } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import { usageLimitRows } from "./threadUsagePanel.logic";

const NOW = Date.parse("2026-09-03T11:00:00.000Z");

function rowsFor(driver: string, windows: readonly ServerProviderUsageWindow[]) {
  const account: LimitAccount = {
    key: "a",
    driver: ProviderDriverKind.make(driver),
    displayName: "a",
    email: undefined,
    plan: undefined,
    accentColor: undefined,
    environments: [],
    sourceLabel: null,
    redeem: null,
    limits: { checkedAt: "2026-09-03T11:00:00.000Z", windows: [...windows] },
  };
  const [pool] = collectLimitPools([account], NOW);
  return pool
    ? usageLimitRows(pool).map(({ label, remainingPercent }) => [label, remainingPercent])
    : [];
}

describe("usageLimitRows", () => {
  it("shows the session and the tightest weekly window", () => {
    expect(
      rowsFor("claudeAgent", [
        {
          id: "seven_day_opus",
          kind: "weekly",
          label: "Weekly Opus",
          usedPercent: 10,
          resetsAt: "2026-09-08T00:00:00.000Z",
        },
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          usedPercent: 38,
          resetsAt: "2026-09-03T13:00:00.000Z",
          windowDurationMins: 300,
        },
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 69,
          resetsAt: "2026-09-08T00:00:00.000Z",
          windowDurationMins: 10080,
        },
      ]),
    ).toEqual([
      ["5h", 62],
      ["Week", 31],
    ]);
  });

  it("labels odd session lengths in minutes and hides quotas beside rate windows", () => {
    expect(
      rowsFor("codex", [
        {
          id: "primary",
          kind: "session",
          label: "Session",
          usedPercent: 0,
          windowDurationMins: 90,
        },
        { id: "credits", kind: "monthly", label: "Credits", usedPercent: 25 },
      ]),
    ).toEqual([["90m", 100]]);
  });

  it("keeps the session length label while the weekly window is spent", () => {
    expect(
      rowsFor("claudeAgent", [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          usedPercent: 20,
          resetsAt: "2026-09-03T13:00:00.000Z",
          windowDurationMins: 300,
        },
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 100,
          resetsAt: "2026-09-08T00:00:00.000Z",
          windowDurationMins: 10080,
        },
      ]),
    ).toEqual([
      ["5h", 0],
      ["Week", 0],
    ]);
  });

  it("shows an exhausted monthly quota beside rate windows", () => {
    expect(
      rowsFor("claudeAgent", [
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 40,
          windowDurationMins: 10080,
        },
        { id: "spend", kind: "monthly", label: "Extra usage", usedPercent: 100 },
      ]),
    ).toEqual([
      ["Week", 60],
      ["Month", 0],
    ]);
  });

  it("shows monthly and other quotas when a driver has no rate windows", () => {
    expect(
      rowsFor("grok", [
        { id: "credits", kind: "monthly", label: "Credits", usedPercent: 25 },
        { id: "extra", kind: "other", label: "Extra", usedPercent: 50 },
      ]),
    ).toEqual([
      ["Month", 75],
      ["Extra", 50],
    ]);
  });
});
