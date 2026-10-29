import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  type Project,
  ProjectId,
  ProviderInstanceId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type TerminalCloseInput,
  type TerminalEvent,
  type TerminalSessionSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import { TestClock } from "effect/testing";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import * as TerminalMcpService from "./TerminalMcpService.ts";

const threadId = ThreadId.make("thread-terminal-test");
const projectId = ProjectId.make("project-terminal-test");

const scope: McpInvocationContext.McpThreadInvocationScope = {
  environmentId: EnvironmentId.make("environment-terminal-test"),
  requestNamespace: "provider-session-terminal-test",
  thread: {
    threadId,
    providerSessionId: "provider-session-terminal-test",
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

type Session = TerminalSessionSnapshot & { hasRunningSubprocess: boolean };

const makeHarness = Effect.fn(function* (
  options: {
    readonly runtimeMode?: RuntimeMode;
    readonly interactionMode?: ProviderInteractionMode;
    readonly worktreePath?: string | null;
    readonly openGate?: Deferred.Deferred<void>;
  } = {},
) {
  const sessions = new Map<string, Session>();
  const opened = yield* Queue.unbounded<{ terminalId: string; cwd: string }>();
  const writes = yield* Queue.unbounded<string>();
  const closes = yield* Queue.unbounded<TerminalCloseInput>();
  const listeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();
  const terminals = Layer.mock(TerminalManager.TerminalManager)({
    open: (input) =>
      Effect.suspend(() => {
        const session: Session = {
          threadId: input.threadId,
          terminalId: input.terminalId,
          cwd: input.cwd,
          worktreePath: input.worktreePath ?? null,
          status: "running",
          pid: 42,
          history: "",
          exitCode: null,
          exitSignal: null,
          label: "zsh",
          updatedAt: "2026-01-01T00:00:00.000Z",
          hasRunningSubprocess: false,
        };
        return Queue.offer(opened, { terminalId: input.terminalId, cwd: input.cwd }).pipe(
          Effect.andThen(options.openGate ? Deferred.await(options.openGate) : Effect.void),
          Effect.andThen(Effect.sync(() => sessions.set(input.terminalId, session))),
          Effect.as(session),
        );
      }),
    snapshot: (input) => Effect.sync(() => Option.fromNullishOr(sessions.get(input.terminalId))),
    subscribe: (listener) =>
      Effect.sync(() => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    getShell: () => Effect.succeed("/bin/zsh"),
    write: (input) => Queue.offer(writes, input.data).pipe(Effect.asVoid),
    close: (input) =>
      Queue.offer(closes, input).pipe(
        Effect.andThen(Effect.sync(() => void sessions.delete(input.terminalId ?? ""))),
      ),
  });
  const service = yield* TerminalMcpService.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        terminals,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: () =>
            Effect.succeed({
              id: threadId,
              projectId,
              runtimeMode: options.runtimeMode ?? "full-access",
              interactionMode: options.interactionMode ?? "default",
              worktreePath: options.worktreePath ?? null,
              deletedAt: null,
            } as OrchestrationV2ThreadShell),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeedSome({ workspaceRoot: "/repo" } as Project),
        }),
      ),
    ),
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provideService(HostProcess.Environment, { SHELL: "/bin/zsh" }),
  );
  return { service, sessions, opened, writes, closes };
});

describe("TerminalMcpService", () => {
  it.effect("runs the command in an agent tab in the thread's workspace", () =>
    Effect.gen(function* () {
      const { service, opened, writes } = yield* makeHarness({ worktreePath: "/repo/wt" });
      const result = yield* service.run(scope, { name: "Dev Server!", command: "./gradlew run" });
      expect(result).toEqual({ terminalId: "agent-dev-server", cwd: "/repo/wt" });
      expect(yield* Queue.takeAll(opened)).toEqual([
        { terminalId: "agent-dev-server", cwd: "/repo/wt" },
      ]);
      yield* TestClock.adjust("3 seconds");
      expect(yield* Queue.take(writes)).toBe(" ./gradlew run\r");
    }),
  );

  it.effect("admits only one of two concurrent runs with the same name", () =>
    Effect.gen(function* () {
      const openGate = yield* Deferred.make<void>();
      const { service, opened } = yield* makeHarness({ openGate });
      const first = yield* Effect.forkChild(
        Effect.result(service.run(scope, { name: "server", command: "a" })),
      );
      const second = yield* Effect.forkChild(
        Effect.result(service.run(scope, { name: "server", command: "b" })),
      );
      yield* Queue.take(opened);
      yield* Deferred.succeed(openGate, undefined);
      const results = [yield* Fiber.join(first), yield* Fiber.join(second)];
      expect(results.map((result) => result._tag)).toEqual(["Success", "Failure"]);
      expect(yield* Queue.size(opened)).toBe(0);
    }),
  );

  it.effect.each([
    ["approval-required", "default"],
    ["auto", "default"],
    ["full-access", "plan"],
  ] as const)("refuses to run in %s/%s mode", ([runtimeMode, interactionMode]) =>
    Effect.gen(function* () {
      const { service, opened } = yield* makeHarness({ runtimeMode, interactionMode });
      const error = yield* Effect.flip(service.run(scope, { name: "server", command: "x" }));
      expect(error.code).toBe("runtime_mode_escalation_denied");
      expect(yield* Queue.size(opened)).toBe(0);
    }),
  );

  it.effect("reads the last lines as plain text and stops the tab", () =>
    Effect.gen(function* () {
      const { service, sessions, closes } = yield* makeHarness();
      yield* service.run(scope, { name: "server", command: "x" });
      const session = sessions.get("agent-server");
      if (session === undefined) return yield* Effect.die("terminal did not open");
      sessions.set("agent-server", {
        ...session,
        hasRunningSubprocess: true,
        history: "one\r\n\x1b[32mtwo\x1b[0m\r\nloading 10%\rloading 99%\r\nthree\r\n",
      });
      expect(yield* service.read(scope, { terminalId: "agent-server", lines: 3 })).toEqual({
        terminalId: "agent-server",
        status: "running",
        busy: true,
        exitCode: null,
        output: "two\nloading 99%\nthree",
      });

      expect(yield* service.stop(scope, { terminalId: "agent-server" })).toEqual({
        terminalId: "agent-server",
        stopped: true,
      });
      expect(yield* Queue.take(closes)).toMatchObject({ deleteHistory: true });
      const closed = yield* Effect.flip(service.read(scope, { terminalId: "agent-server" }));
      expect(closed.code).toBe("invalid_request");
    }),
  );

  it.effect("keeps the user's own terminals out of reach", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const stopped = yield* Effect.flip(service.stop(scope, { terminalId: "term-1" }));
      const read = yield* Effect.flip(service.read(scope, { terminalId: "term-1" }));
      expect([stopped.code, read.code]).toEqual(["invalid_request", "invalid_request"]);
    }),
  );
});
