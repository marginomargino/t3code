import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { TerminalSessionStatus } from "./terminal.ts";

/** Terminal ids `t3_terminal_run` opens; clients treat their server-side close as final. */
export const AGENT_TERMINAL_ID_PREFIX = "agent-";
export const TERMINAL_MCP_READ_DEFAULT_LINES = 200;
const TERMINAL_MCP_READ_MAX_LINES = 2_000;

export const TerminalMcpRunInput = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(48)).annotate({
    description: "Short tab name, e.g. `server`. Becomes terminal id `agent-<name>`.",
  }),
  command: TrimmedNonEmptyString.check(Schema.isMaxLength(16_000)),
});
export type TerminalMcpRunInput = typeof TerminalMcpRunInput.Type;

export const TerminalMcpRunResult = Schema.Struct({
  terminalId: Schema.String,
  cwd: Schema.String,
});
export type TerminalMcpRunResult = typeof TerminalMcpRunResult.Type;

export const TerminalMcpTarget = Schema.Struct({
  terminalId: TrimmedNonEmptyString,
});
export type TerminalMcpTarget = typeof TerminalMcpTarget.Type;

export const TerminalMcpReadInput = Schema.Struct({
  terminalId: TrimmedNonEmptyString,
  lines: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: TERMINAL_MCP_READ_MAX_LINES }),
    ).annotate({ description: `Default ${TERMINAL_MCP_READ_DEFAULT_LINES}.` }),
  ),
});
export type TerminalMcpReadInput = typeof TerminalMcpReadInput.Type;

export const TerminalMcpReadResult = Schema.Struct({
  terminalId: Schema.String,
  status: TerminalSessionStatus,
  /** True while a program runs in the shell; false once it returned to the prompt. */
  busy: Schema.Boolean,
  exitCode: Schema.NullOr(Schema.Int),
  output: Schema.String,
});
export type TerminalMcpReadResult = typeof TerminalMcpReadResult.Type;

export const TerminalMcpStopResult = Schema.Struct({
  terminalId: Schema.String,
  stopped: Schema.Boolean,
});
export type TerminalMcpStopResult = typeof TerminalMcpStopResult.Type;
