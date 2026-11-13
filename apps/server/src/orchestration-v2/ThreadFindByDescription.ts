import {
  defaultInstanceIdForDriver,
  IsoDateTime,
  type OrchestrationFindThreadsByDescriptionInput,
  type OrchestrationFindThreadsByDescriptionResult,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import type { ThreadFindCandidate } from "@t3tools/provider-core/server/textGeneration";
import { THREAD_FIND_MAX_MATCHES } from "@t3tools/provider-core/server/textGenerationPrompts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import * as ServerConfig from "../config.ts";
import * as Settings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";

const CATALOG_DAYS = 60;
const CATALOG_THREAD_LIMIT = 300;
const USER_MESSAGE_CHARS = 200;
const USER_MESSAGES_BUDGET = 1500;
const LAST_REPLY_CHARS = 300;
// Keeps the one model call well inside a small context window; the newest threads win.
const CATALOG_CHARS_BUDGET = 200_000;
const CLAUDE_DRIVER = "claudeAgent";

const CatalogThreadRow = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  projectTitle: Schema.String,
  branch: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
});
const CatalogMessageRow = Schema.Struct({
  threadId: ThreadId,
  text: Schema.String,
});
const CatalogRequest = Schema.Struct({
  since: Schema.String,
  instanceIds: Schema.fromJsonString(Schema.Array(Schema.String)),
});
const ThreadIdsRequest = Schema.fromJsonString(Schema.Array(Schema.String));

// By code point, so an emoji at the cut is never split into a lone surrogate.
const clip = (text: string, length: number) => {
  const flat = Array.from(text.replace(/\s+/g, " ").trim());
  return flat.length > length ? `${flat.slice(0, length - 1).join("")}…` : flat.join("");
};

/** Every user message, clipped; past the budget the thread's start and end survive, not its middle. */
export const catalogUserMessages = (messages: ReadonlyArray<string>) => {
  const lines = messages.map((text) => `- ${clip(text, USER_MESSAGE_CHARS)}`);
  if (lines.join("\n").length <= USER_MESSAGES_BUDGET) return lines.join("\n");
  const gap = "- …";
  const half = (USER_MESSAGES_BUDGET - gap.length - 2) / 2;
  const head: Array<string> = [];
  const tail: Array<string> = [];
  let headLength = 0;
  let tailLength = 0;
  for (const line of lines) {
    if (headLength + line.length > half) break;
    head.push(line);
    headLength += line.length + 1;
  }
  for (const line of lines.slice(head.length).toReversed()) {
    if (tailLength + line.length > half) break;
    tail.unshift(line);
    tailLength += line.length + 1;
  }
  return [...head, gap, ...tail].join("\n");
};

const loadCatalog = Effect.fn("ThreadFindByDescription.loadCatalog")(function* (
  instanceIds: ReadonlyArray<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  const since = DateTime.subtract(yield* DateTime.now, { days: CATALOG_DAYS });
  const threads = yield* SqlSchema.findAll({
    Request: CatalogRequest,
    Result: CatalogThreadRow,
    execute: (request) => sql`
      SELECT
        threads.thread_id AS "threadId",
        threads.title AS title,
        projects.title AS "projectTitle",
        json_extract(threads.payload_json, '$.branch') AS branch,
        threads.updated_at AS "updatedAt",
        threads.archived_at AS "archivedAt"
      FROM orchestration_v2_projection_threads AS threads
      INNER JOIN projection_projects AS projects ON projects.project_id = threads.project_id
      WHERE threads.deleted_at IS NULL
        AND projects.deleted_at IS NULL
        AND threads.updated_at >= ${request.since}
        AND threads.provider_instance_id IN (SELECT value FROM json_each(${request.instanceIds}))
        AND json_extract(threads.payload_json, '$.lineage.relationshipToParent')
          IS NOT 'subagent'
      ORDER BY threads.updated_at DESC
      LIMIT ${CATALOG_THREAD_LIMIT}
    `,
  })({ since: DateTime.formatIso(since), instanceIds });
  if (threads.length === 0) return [];
  const threadIds = threads.map((thread) => thread.threadId);
  const userMessages = yield* SqlSchema.findAll({
    Request: ThreadIdsRequest,
    Result: CatalogMessageRow,
    execute: (ids) => sql`
      SELECT
        messages.thread_id AS "threadId",
        substr(json_extract(messages.payload_json, '$.text'), 1, ${USER_MESSAGE_CHARS * 2}) AS text
      FROM orchestration_v2_projection_messages AS messages
      WHERE messages.thread_id IN (SELECT value FROM json_each(${ids}))
        AND messages.role = 'user'
        AND COALESCE(json_extract(messages.payload_json, '$.createdBy'), 'user') = 'user'
        AND json_extract(messages.payload_json, '$.text') IS NOT NULL
      ORDER BY messages.thread_id, messages.created_at
    `,
  })(threadIds);
  const lastReplies = yield* SqlSchema.findAll({
    Request: ThreadIdsRequest,
    Result: CatalogMessageRow,
    execute: (ids) => sql`
      SELECT "threadId", text FROM (
        SELECT
          messages.thread_id AS "threadId",
          substr(json_extract(messages.payload_json, '$.text'), 1, ${LAST_REPLY_CHARS * 2}) AS text,
          ROW_NUMBER() OVER (
            PARTITION BY messages.thread_id
            ORDER BY messages.created_at DESC, messages.message_id DESC
          ) AS position
        FROM orchestration_v2_projection_messages AS messages
        WHERE messages.thread_id IN (SELECT value FROM json_each(${ids}))
          AND messages.role = 'assistant'
          AND messages.streaming = 0
          AND json_extract(messages.payload_json, '$.text') IS NOT NULL
      )
      WHERE position = 1
    `,
  })(threadIds);
  const messagesByThread = Map.groupBy(userMessages, (row) => row.threadId);
  const replyByThread = new Map(lastReplies.map((row) => [row.threadId, row.text]));
  const catalog: Array<
    (typeof threads)[number] & { readonly userMessages: string; readonly lastReply: string }
  > = [];
  let size = 0;
  for (const thread of threads) {
    const entry = {
      ...thread,
      userMessages: catalogUserMessages(
        (messagesByThread.get(thread.threadId) ?? []).map((row) => row.text),
      ),
      lastReply: clip(replyByThread.get(thread.threadId) ?? "", LAST_REPLY_CHARS),
    };
    size += entry.title.length + entry.userMessages.length + entry.lastReply.length + 200;
    if (size > CATALOG_CHARS_BUDGET) break;
    catalog.push(entry);
  }
  return catalog;
});

/** Ranks the user's recent Claude threads against a free-text description of the work. */
export const findThreadsByDescription = Effect.fn(
  "ThreadFindByDescription.findThreadsByDescription",
)(function* (input: OrchestrationFindThreadsByDescriptionInput) {
  const settings = yield* (yield* Settings.ServerSettingsService).getSettings;
  const claudeInstances = [
    defaultInstanceIdForDriver(ProviderDriverKind.make(CLAUDE_DRIVER)),
    ...Object.entries(settings.providerInstances)
      .filter(([, instance]) => instance.driver === CLAUDE_DRIVER)
      .map(([instanceId]) => instanceId),
  ];
  const catalog = yield* loadCatalog([...new Set(claudeInstances)]);
  if (catalog.length === 0) return { matches: [] };
  const { cwd } = yield* ServerConfig.ServerConfig;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const threads: ReadonlyArray<ThreadFindCandidate> = catalog.map((thread) => ({
    threadId: thread.threadId,
    title: thread.title,
    project: thread.projectTitle,
    branch: thread.branch,
    updatedAt: thread.updatedAt,
    userMessages: thread.userMessages,
    lastReply: thread.lastReply,
  }));
  const found = yield* textGeneration.findThreads({
    cwd,
    description: input.description,
    threads,
    modelSelection: settings.textGenerationModelSelection,
  });
  const byId = new Map(catalog.map((thread) => [thread.threadId as string, thread]));
  const seen = new Set<string>();
  const matches: Array<OrchestrationFindThreadsByDescriptionResult["matches"][number]> = [];
  for (const match of found.matches) {
    const thread = byId.get(match.threadId);
    if (thread === undefined || seen.has(match.threadId)) continue;
    seen.add(match.threadId);
    matches.push({
      threadId: thread.threadId,
      title: thread.title,
      projectTitle: thread.projectTitle,
      updatedAt: thread.updatedAt,
      archived: thread.archivedAt !== null,
      recap: match.recap.trim(),
      reason: match.reason.trim(),
    });
    if (matches.length === THREAD_FIND_MAX_MATCHES) break;
  }
  return { matches };
});
