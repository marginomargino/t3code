import {
  AGENT_TERMINAL_ID_PREFIX,
  linkOriginIsFenced,
  OrchestratorMcpFailure,
  TERMINAL_MCP_READ_DEFAULT_LINES,
  type TerminalMcpReadInput,
  type TerminalMcpReadResult,
  type TerminalMcpRunInput,
  type TerminalMcpRunResult,
  type TerminalMcpStopResult,
  type TerminalMcpTarget,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodeUtil from "node:util";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import type { McpThreadInvocationScope } from "./McpInvocationContext.ts";

export class TerminalMcpService extends Context.Service<
  TerminalMcpService,
  {
    readonly run: (
      scope: McpThreadInvocationScope,
      input: TerminalMcpRunInput,
    ) => Effect.Effect<TerminalMcpRunResult, OrchestratorMcpFailure>;
    readonly read: (
      scope: McpThreadInvocationScope,
      input: TerminalMcpReadInput,
    ) => Effect.Effect<TerminalMcpReadResult, OrchestratorMcpFailure>;
    readonly stop: (
      scope: McpThreadInvocationScope,
      input: TerminalMcpTarget,
    ) => Effect.Effect<TerminalMcpStopResult, OrchestratorMcpFailure>;
  }
>()("t3/mcp/TerminalMcpService") {}

const AUTO_REVIEWED_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent", "codex"]);

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

const agentTerminalId = (name: string): string | undefined => {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length === 0 ? undefined : `${AGENT_TERMINAL_ID_PREFIX}${slug}`;
};

/** Plain text of the last `lines` lines; the PTY history keeps escape codes and CR redraws. */
const terminalOutputTail = (history: string, lines: number): string =>
  NodeUtil.stripVTControlCharacters(history)
    .trimEnd()
    .split(/\r?\n/)
    .map((line) => line.slice(line.lastIndexOf("\r") + 1))
    .slice(-lines)
    .join("\n");

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const terminals = yield* TerminalManager.TerminalManager;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const starter = yield* ProjectSetupScriptRunner.makeTerminalCommandStarter;
  // The busy check reads session state that only changes once the terminal opens.
  const admission = yield* KeyedLock.make<string>();

  const unavailable = (message: string) => () => failure("orchestration_error", message);

  const readAgentSession = Effect.fn("TerminalMcpService.readAgentSession")(function* (
    scope: McpThreadInvocationScope,
    terminalId: string,
  ) {
    if (!terminalId.startsWith(AGENT_TERMINAL_ID_PREFIX)) {
      return yield* failure(
        "invalid_request",
        `Only terminals started with t3_terminal_run (\`${AGENT_TERMINAL_ID_PREFIX}*\`) are available.`,
      );
    }
    return yield* terminals.snapshot({ threadId: scope.thread.threadId, terminalId });
  });

  const run: TerminalMcpService["Service"]["run"] = Effect.fn("TerminalMcpService.run")(
    function* (scope, input) {
      const terminalId = agentTerminalId(input.name);
      if (terminalId === undefined) {
        return yield* failure("invalid_request", "`name` needs at least one letter or digit.");
      }
      const thread = yield* threads
        .getThreadShell(scope.thread.threadId)
        .pipe(Effect.mapError(unavailable("The calling thread could not be read.")));
      if (thread === null || thread.deletedAt !== null) {
        return yield* failure("thread_not_found", "The calling thread was not found.");
      }
      // Terminal input skips the provider's command approvals; in auto mode only Claude and Codex
      // still review this tool call itself (ClaudeAdapterV2 asks for it, Codex prompts per tool).
      const reviewedInAuto =
        thread.runtimeMode === "auto" &&
        (yield* providers.getProviders).some(
          (provider) =>
            provider.instanceId === thread.providerInstanceId &&
            AUTO_REVIEWED_DRIVERS.has(provider.driver),
        );
      if (
        (thread.runtimeMode !== "full-access" && !reviewedInAuto) ||
        thread.interactionMode !== "default"
      ) {
        return yield* failure(
          "runtime_mode_escalation_denied",
          "t3_terminal_run needs full access, or auto mode on Claude or Codex, outside plan mode. Use your own shell tool instead.",
        );
      }
      if (thread.linkOrigin !== undefined && linkOriginIsFenced(thread.linkOrigin)) {
        return yield* failure(
          "capability_denied",
          "Threads a linked environment started cannot run commands here.",
        );
      }
      const project = yield* projects
        .getById(thread.projectId)
        .pipe(Effect.mapError(unavailable("The thread's project could not be read.")));
      if (Option.isNone(project)) {
        return yield* failure("invalid_request", "The thread's project was not found.");
      }
      const workspaceRoot = project.value.workspaceRoot;
      const cwd = thread.worktreePath ?? workspaceRoot;

      return yield* admission.withLock(
        `${thread.id}\u0000${terminalId}`,
        Effect.gen(function* () {
          const existing = yield* terminals.snapshot({ threadId: thread.id, terminalId });
          if (
            Option.isSome(existing) &&
            (existing.value.status === "running" || existing.value.status === "starting")
          ) {
            return yield* failure(
              "invalid_request",
              `Terminal \`${terminalId}\` is still open. Call t3_terminal_stop first, or pick another name.`,
            );
          }
          yield* starter
            .start({
              threadId: thread.id,
              terminalId,
              cwd,
              worktreePath: thread.worktreePath,
              env: {
                ...projectScriptRuntimeEnv({
                  project: { cwd: workspaceRoot },
                  worktreePath: thread.worktreePath,
                }),
                // Before client attachment, truecolor probes wait for terminal replies nobody can send.
                COLORTERM: "",
              },
              command: input.command,
            })
            .pipe(
              Effect.mapError((error) =>
                failure("orchestration_error", `The terminal could not open: ${error.message}`),
              ),
            );
          return { terminalId, cwd };
        }),
      );
    },
  );

  const read: TerminalMcpService["Service"]["read"] = Effect.fn("TerminalMcpService.read")(
    function* (scope, input) {
      const session = yield* readAgentSession(scope, input.terminalId);
      if (Option.isNone(session)) {
        return yield* failure("invalid_request", `Terminal \`${input.terminalId}\` is not open.`);
      }
      return {
        terminalId: input.terminalId,
        status: session.value.status,
        busy: session.value.hasRunningSubprocess,
        exitCode: session.value.exitCode,
        output: terminalOutputTail(
          session.value.history,
          input.lines ?? TERMINAL_MCP_READ_DEFAULT_LINES,
        ),
      };
    },
  );

  const stop: TerminalMcpService["Service"]["stop"] = Effect.fn("TerminalMcpService.stop")(
    function* (scope, input) {
      const session = yield* readAgentSession(scope, input.terminalId);
      if (Option.isNone(session)) return { terminalId: input.terminalId, stopped: false };
      yield* terminals
        // A rerun under this name must not show the stopped run's output.
        .close({
          threadId: scope.thread.threadId,
          terminalId: input.terminalId,
          deleteHistory: true,
        })
        .pipe(Effect.mapError(unavailable(`Terminal \`${input.terminalId}\` could not close.`)));
      return { terminalId: input.terminalId, stopped: true };
    },
  );

  return TerminalMcpService.of({ run, read, stop });
});

export const layer = Layer.effect(TerminalMcpService, make);
