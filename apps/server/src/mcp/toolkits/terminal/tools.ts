import {
  OrchestratorMcpFailure,
  TerminalMcpReadInput,
  TerminalMcpReadResult,
  TerminalMcpRunInput,
  TerminalMcpRunResult,
  TerminalMcpStopResult,
  TerminalMcpTarget,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as TerminalMcpService from "../../TerminalMcpService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  TerminalMcpService.TerminalMcpService,
];

const TerminalRunTool = Tool.make("t3_terminal_run", {
  description:
    "Run a long-lived command (dev server, watcher, `./gradlew run`) in a T3 terminal tab of THIS thread, so the user can watch it live and press Ctrl+C. Prefer it over background shell commands for anything the user should see. Runs in the thread's workspace and outlives your turn. Fails while a tab with this name is open: `t3_terminal_stop` first to restart. Needs full access, or auto mode on Claude or Codex.",
  parameters: TerminalMcpRunInput,
  success: TerminalMcpRunResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Run a command in a T3 terminal")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const TerminalReadTool = Tool.make("t3_terminal_read", {
  description:
    "Read the last lines of a `t3_terminal_run` tab as plain text, with its status. `busy` is false once the command returned to the prompt.",
  parameters: TerminalMcpReadInput,
  success: TerminalMcpReadResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read a T3 terminal")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const TerminalStopTool = Tool.make("t3_terminal_stop", {
  description: "Stop a `t3_terminal_run` command and close its tab.",
  parameters: TerminalMcpTarget,
  success: TerminalMcpStopResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Stop a T3 terminal")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const TerminalToolkit = Toolkit.make(TerminalRunTool, TerminalReadTool, TerminalStopTool);
