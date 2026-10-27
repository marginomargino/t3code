import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  MessageId,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";

export const OrchestrationThreadSearchSource = Schema.Literals(["user", "assistant"]);
export type OrchestrationThreadSearchSource = typeof OrchestrationThreadSearchSource.Type;

/** Longer queries are cut to this before they are sent. */
export const THREAD_SEARCH_QUERY_MAX_LENGTH = 200;

// The server's SQLite client is synchronous and single-connection. Bound both
// scan input and response size so a search cannot monopolize that connection.
export const OrchestrationSearchThreadsInput = Schema.Struct({
  query: TrimmedString.check(
    Schema.isMinLength(2),
    Schema.isMaxLength(THREAD_SEARCH_QUERY_MAX_LENGTH),
  ),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export type OrchestrationSearchThreadsInput = typeof OrchestrationSearchThreadsInput.Type;

export const OrchestrationThreadSearchMatch = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  source: OrchestrationThreadSearchSource,
  snippet: Schema.String.check(Schema.isMaxLength(240)),
  messageCreatedAt: Schema.NullOr(IsoDateTime),
  /**
   * How well the message matches: 1 for whole words, 0.8 when a word only
   * starts one, 0.3 when one only appears inside words, 0.25 more when the
   * words are written together as typed, else 0.1 more when they are near.
   * Older servers omit it.
   */
  quality: Schema.optionalKey(Schema.Finite),
  /** How many of the thread's newest messages match. Older servers omit it. */
  hits: Schema.optionalKey(Schema.Int),
  /** The message the snippet is from. Older servers omit it. */
  messageId: Schema.optionalKey(MessageId),
});
export type OrchestrationThreadSearchMatch = typeof OrchestrationThreadSearchMatch.Type;

export const OrchestrationSearchThreadsResult = Schema.Struct({
  matches: Schema.Array(OrchestrationThreadSearchMatch),
});
export type OrchestrationSearchThreadsResult = typeof OrchestrationSearchThreadsResult.Type;

/** A semantic search over the user's recent Claude threads, ranked by a text generation model. */
export const OrchestrationFindThreadsByDescriptionInput = Schema.Struct({
  description: TrimmedString.check(Schema.isMinLength(3), Schema.isMaxLength(500)),
});
export type OrchestrationFindThreadsByDescriptionInput =
  typeof OrchestrationFindThreadsByDescriptionInput.Type;

export const OrchestrationFoundThread = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  projectTitle: Schema.String,
  updatedAt: IsoDateTime,
  /** Archived threads open only after unarchiving. */
  archived: Schema.Boolean,
  recap: Schema.String,
  reason: Schema.String,
});
export type OrchestrationFoundThread = typeof OrchestrationFoundThread.Type;

export const OrchestrationFindThreadsByDescriptionResult = Schema.Struct({
  matches: Schema.Array(OrchestrationFoundThread),
});
export type OrchestrationFindThreadsByDescriptionResult =
  typeof OrchestrationFindThreadsByDescriptionResult.Type;

export class OrchestrationSearchThreadsError extends Schema.TaggedError<OrchestrationSearchThreadsError>()(
  "OrchestrationSearchThreadsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
