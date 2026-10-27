import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { settleAiThreadFind, startAiThreadFind, useAiThreadFindStore } from "./aiThreadFindStore";

const environmentId = EnvironmentId.make("environment:local");
const found = (id: string) => ({
  threadId: ThreadId.make(id),
  title: id,
  projectTitle: "Project",
  updatedAt: "2026-10-27T00:00:00.000Z",
  archived: false,
  recap: "recap",
  reason: "reason",
});

it("ignores the answer of a search a newer one replaced", () => {
  const first = startAiThreadFind("billing sync", environmentId);
  const second = startAiThreadFind("stripe webhooks", environmentId);

  expect(settleAiThreadFind(first, { matches: [found("thread:old")] })).toBe(false);
  expect(useAiThreadFindStore.getState()).toMatchObject({
    status: "running",
    description: "stripe webhooks",
    matches: [],
  });

  expect(settleAiThreadFind(second, { matches: [found("thread:new")] })).toBe(true);
  expect(useAiThreadFindStore.getState()).toMatchObject({
    status: "done",
    matches: [{ threadId: "thread:new" }],
  });
});

it("keeps the failure of the current search", () => {
  const run = startAiThreadFind("anything", environmentId);
  settleAiThreadFind(run, { error: "Model unavailable" });
  expect(useAiThreadFindStore.getState()).toMatchObject({
    status: "failed",
    error: "Model unavailable",
  });
});
