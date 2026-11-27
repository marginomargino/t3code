import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import type { ThreadFindInput } from "@t3tools/provider-core/server/textGeneration";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Settings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadFindByDescription from "./ThreadFindByDescription.ts";

const claude = ProviderInstanceId.make("claudeAgent");
const work = ProviderInstanceId.make("claude-work");
const codex = ProviderInstanceId.make("codex");
const project = ProjectId.make("project:find");
const goneProject = ProjectId.make("project:gone");
const day = (n: number) => DateTime.makeUnsafe(Date.UTC(2026, 8, 1) + n * 86_400_000);

const projectEvent = (
  projectId: ProjectId,
  type: "project.created" | "project.deleted",
): Parameters<ProjectStore.ProjectStoreV2["Service"]["apply"]>[0] =>
  type === "project.deleted"
    ? {
        sequence: 0,
        eventId: EventId.make(`deleted:${projectId}`),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: DateTime.formatIso(day(1)),
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type,
        payload: { projectId, deletedAt: DateTime.formatIso(day(1)) },
      }
    : {
        sequence: 0,
        eventId: EventId.make(`created:${projectId}`),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: DateTime.formatIso(day(0)),
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type,
        payload: {
          projectId,
          title: "Billing app",
          workspaceRoot: `/work/${projectId}`,
          defaultModelSelection: null,
          scripts: [],
          createdAt: DateTime.formatIso(day(0)),
          updatedAt: DateTime.formatIso(day(0)),
        },
      };

const applyProject = (event: ReturnType<typeof projectEvent>) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) => projects.apply(event));
const createProject = applyProject(projectEvent(project, "project.created"));

const thread = (
  threadId: ThreadId,
  options: {
    readonly instance?: ProviderInstanceId;
    readonly updatedDay?: number;
    readonly archived?: boolean;
    readonly deleted?: boolean;
    readonly subagentOf?: ThreadId;
    readonly projectId?: ProjectId;
  } = {},
): OrchestrationV2DomainEvent => {
  const providerInstanceId = options.instance ?? claude;
  const updatedAt = day(options.updatedDay ?? 100);
  return {
    id: EventId.make(`created:${threadId}`),
    type: "thread.created",
    threadId,
    providerInstanceId,
    occurredAt: updatedAt,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: options.projectId ?? project,
      title: `Title of ${threadId}`,
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "claude-opus-5-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      linkedPullRequest: null,
      branchPullRequest: null,
      activeProviderThreadId: null,
      lineage: options.subagentOf
        ? {
            parentThreadId: options.subagentOf,
            relationshipToParent: "subagent",
            rootThreadId: options.subagentOf,
          }
        : { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: updatedAt,
      updatedAt,
      archivedAt: options.archived ? updatedAt : null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: options.deleted ? updatedAt : null,
    },
  };
};

const message = (
  threadId: ThreadId,
  id: string,
  role: "user" | "assistant",
  text: string,
  minute: number,
  createdBy: "user" | "agent" = role === "user" ? "user" : "agent",
): OrchestrationV2DomainEvent => {
  const at = DateTime.makeUnsafe(Date.UTC(2026, 11, 1, 0, minute));
  return {
    id: EventId.make(`message:${id}`),
    type: "message.updated",
    threadId,
    providerInstanceId: claude,
    occurredAt: at,
    payload: {
      createdBy,
      creationSource: role === "user" ? "web" : "provider",
      id: MessageId.make(id),
      threadId,
      runId: null,
      nodeId: null,
      role,
      text,
      attachments: [],
      streaming: false,
      createdAt: at,
      updatedAt: at,
    },
  };
};

const harness = (reply: (input: ThreadFindInput) => ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<ThreadFindInput>>([]);
    const layer = Layer.mergeAll(
      Layer.mock(Settings.ServerSettingsService)({
        getSettings: Effect.succeed({
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [work]: { driver: ProviderDriverKind.make("claudeAgent") },
            [codex]: { driver: ProviderDriverKind.make("codex") },
          },
        }),
      }),
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-thread-find-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
      Layer.mock(TextGeneration.TextGeneration)({
        findThreads: (input) =>
          Ref.update(calls, (all) => [...all, input]).pipe(
            Effect.as({
              matches: reply(input).map((threadId) => ({
                threadId,
                recap: ` recap ${threadId} `,
                reason: "fits",
              })),
            }),
          ),
      }),
    );
    return { calls, layer };
  });

it.layer(
  Layer.mergeAll(ProjectionStore.layer, ProjectStore.layer).pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
  ),
)("ThreadFindByDescription", (it) => {
  it.effect("catalogs recent Claude threads with every user message, including archived ones", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* createProject;
      const billing = ThreadId.make("thread:billing");
      const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
        thread(billing),
        message(billing, "billing-1", "user", "Clean up the backend services", 1),
        message(billing, "billing-2", "user", "Now fix the Stripe billing sync retries", 2),
        message(billing, "billing-3", "user", "Finally tidy the flaky tests", 3),
        message(billing, "billing-early-reply", "assistant", "Starting the cleanup.", 1),
        message(billing, "billing-notice", "user", "Agent notice about the queue", 3, "agent"),
        message(billing, "billing-reply", "assistant", "Tests are green now.", 4),
        thread(ThreadId.make("thread:other-claude"), { instance: work }),
        thread(ThreadId.make("thread:archived"), { archived: true }),
        thread(ThreadId.make("thread:codex"), { instance: codex }),
        thread(ThreadId.make("thread:deleted"), { deleted: true }),
        thread(ThreadId.make("thread:subagent"), { subagentOf: billing }),
        thread(ThreadId.make("thread:old"), { updatedDay: 30 }),
        thread(ThreadId.make("thread:gone-project"), { projectId: goneProject }),
      ];
      yield* applyProject(projectEvent(goneProject, "project.created"));
      yield* Effect.forEach(events, projections.apply, { discard: true });
      yield* applyProject(projectEvent(goneProject, "project.deleted"));
      yield* TestClock.setTime(DateTime.toEpochMillis(day(100)));
      const { calls, layer } = yield* harness(() => []);

      yield* ThreadFindByDescription.findThreadsByDescription({
        description: "where we fixed payments syncing",
      }).pipe(Effect.provide(layer));

      const [call] = yield* Ref.get(calls);
      assert.deepEqual(call?.threads.map((candidate) => candidate.threadId).toSorted(), [
        "thread:archived",
        "thread:billing",
        "thread:other-claude",
      ]);
      const billingCandidate = call?.threads.find((candidate) => candidate.threadId === billing);
      assert.include(billingCandidate?.userMessages, "Stripe billing sync");
      assert.notInclude(billingCandidate?.userMessages, "Agent notice");
      assert.strictEqual(billingCandidate?.lastReply, "Tests are green now.");
      assert.strictEqual(billingCandidate?.project, "Billing app");
    }),
  );

  it.effect("returns only catalog threads, once each, with their labels", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* createProject;
      const known = ThreadId.make("thread:known");
      const shelved = ThreadId.make("thread:shelved");
      const extra = Array.from({ length: 9 }, (_, index) => ThreadId.make(`thread:extra-${index}`));
      yield* Effect.forEach(
        [thread(known), thread(shelved, { archived: true }), ...extra.map((id) => thread(id))],
        projections.apply,
        { discard: true },
      );
      yield* TestClock.setTime(DateTime.toEpochMillis(day(100)));
      const { layer } = yield* harness(() => ["thread:invented", known, known, shelved, ...extra]);

      const result = yield* ThreadFindByDescription.findThreadsByDescription({
        description: "anything",
      }).pipe(Effect.provide(layer));

      assert.strictEqual(result.matches.length, 8);
      assert.deepEqual(result.matches.slice(0, 2), [
        {
          threadId: known,
          title: "Title of thread:known",
          projectTitle: "Billing app",
          updatedAt: DateTime.formatIso(day(100)),
          archived: false,
          recap: "recap thread:known",
          reason: "fits",
        },
        {
          threadId: shelved,
          title: "Title of thread:shelved",
          projectTitle: "Billing app",
          updatedAt: DateTime.formatIso(day(100)),
          archived: true,
          recap: "recap thread:shelved",
          reason: "fits",
        },
      ]);
    }),
  );
});

it("keeps the start and end of a long thread when trimming user messages", () => {
  const messages = Array.from({ length: 40 }, (_, index) => `message ${index} ${"x".repeat(80)}`);
  const catalog = ThreadFindByDescription.catalogUserMessages(messages);
  assert.isAtMost(catalog.length, 1500);
  assert.include(catalog, "message 0 ");
  assert.include(catalog, "message 39 ");
  assert.include(catalog, "- …");
  assert.notInclude(catalog, "message 20 ");
});

it("clips one long message by character without splitting an emoji", () => {
  const catalog = ThreadFindByDescription.catalogUserMessages([`${"x".repeat(198)}😀 and more`]);
  assert.strictEqual(Array.from(catalog).length, 202);
  assert.isTrue(catalog.endsWith("😀…"));
});
