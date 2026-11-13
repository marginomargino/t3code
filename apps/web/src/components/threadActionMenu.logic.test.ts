import { describe, expect, it } from "vite-plus/test";

import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import {
  buildThreadActionMenuItems,
  providerForksWhileRunning,
  type ThreadActionMenuState,
} from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  environmentFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  hasRun: true,
  forksWhileRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        projectFilter: { label: "t3code", isActive: reversed },
        environmentFilter: { label: "Remote", isActive: reversed },
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "fork",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "fork",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("disables archive and turning into a project while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
  });

  it.each([
    { hasRun: true, isRunning: false, forksWhileRunning: false, disabled: false },
    { hasRun: false, isRunning: false, forksWhileRunning: false, disabled: true },
    { hasRun: true, isRunning: true, forksWhileRunning: false, disabled: true },
    { hasRun: false, isRunning: true, forksWhileRunning: false, disabled: true },
    { hasRun: true, isRunning: true, forksWhileRunning: true, disabled: false },
    { hasRun: false, isRunning: true, forksWhileRunning: true, disabled: true },
  ])(
    "fork is disabled=$disabled when has run=$hasRun, running=$isRunning, forks while running=$forksWhileRunning",
    ({ hasRun, isRunning, forksWhileRunning, disabled }) => {
      const forkItem = buildThreadActionMenuItems({
        ...baseState,
        hasRun,
        isRunning,
        forksWhileRunning,
      }).find((item) => item.id === "fork");
      expect(forkItem?.disabled).toBe(disabled);
    },
  );

  it.each([
    { instanceId: "claude-work", expected: true },
    { instanceId: "codex", expected: false },
    { instanceId: "unknown", expected: false },
  ])("only Claude instances fork while running ($instanceId)", ({ instanceId, expected }) => {
    const providers = [
      {
        instanceId: ProviderInstanceId.make("claude-work"),
        driver: ProviderDriverKind.make("claudeAgent"),
      },
      { instanceId: ProviderInstanceId.make("codex"), driver: ProviderDriverKind.make("codex") },
    ];
    expect(providerForksWhileRunning(providers, ProviderInstanceId.make(instanceId))).toBe(
      expected,
    );
  });
});
