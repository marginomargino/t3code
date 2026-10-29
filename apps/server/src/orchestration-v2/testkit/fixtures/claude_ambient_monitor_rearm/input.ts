import type { OrchestratorFixtureInput } from "../shared.ts";

export const CLAUDE_AMBIENT_MONITOR_REARM_PROMPT_1 =
  "Publish /tmp/claude-replay/week-one.html with the Artifact tool, then reply with exactly PUBLISHED and stop.";
export const CLAUDE_AMBIENT_MONITOR_REARM_PROMPT_2 = "Reply with exactly SECOND_DONE and stop.";

export function claudeAmbientMonitorRearmInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: CLAUDE_AMBIENT_MONITOR_REARM_PROMPT_1 },
      { type: "message", text: CLAUDE_AMBIENT_MONITOR_REARM_PROMPT_2 },
    ],
  };
}
