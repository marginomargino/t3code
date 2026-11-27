import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
} from "../shared.ts";
import {
  CLAUDE_AMBIENT_MONITOR_REARM_PROMPT_1,
  CLAUDE_AMBIENT_MONITOR_REARM_PROMPT_2,
} from "./input.ts";

const AMBIENT_TASK_ID = "sx1mv95rm";

// The CLI stops and re-arms a monitor_ws live-update watch on its own; none of that is thread activity.
export function assertClaudeAmbientMonitorRearmOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["completed", "completed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [
    CLAUDE_AMBIENT_MONITOR_REARM_PROMPT_1,
    CLAUDE_AMBIENT_MONITOR_REARM_PROMPT_2,
  ]);

  assert.deepEqual(
    projection.turnItems.flatMap((item) =>
      item.type === "assistant_message" ? [item.text.trim()] : [],
    ),
    ["PUBLISHED", "SECOND_DONE"],
  );
  assert.deepEqual(
    projection.turnItems.flatMap((item) => (item.type === "notification" ? [item.summary] : [])),
    [],
  );
  assert.lengthOf(projection.subagents, 0);
  assert.isFalse(
    result.domainEvents.some(
      (event) =>
        event.type === "provider-thread.updated" &&
        (event.payload.pendingBackgroundTasks ?? []).some(
          (task) => task.taskId === AMBIENT_TASK_ID,
        ),
    ),
    "live-update watchers must stay out of the Waiting roster",
  );
}
