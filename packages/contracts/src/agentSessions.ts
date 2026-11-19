import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const AgentSessionSource = Schema.Literals(["claudeAgent", "codex", "pi"]);
export type AgentSessionSource = typeof AgentSessionSource.Type;

export const AgentSessionImportSource = Schema.Struct({
  provider: AgentSessionSource,
  providerInstanceId: ProviderInstanceId,
  providerSessionId: TrimmedNonEmptyString,
  filePath: TrimmedNonEmptyString,
  size: NonNegativeInt,
  mtimeMs: Schema.NullOr(Schema.Number),
  device: Schema.Number,
  // A decimal string keeps file IDs above 2^53 (common on NTFS) exact. Older
  // records stored a number.
  inode: Schema.NullOr(Schema.Union([Schema.String, Schema.Number])),
  birthtimeMs: Schema.NullOr(Schema.Number),
});
export type AgentSessionImportSource = typeof AgentSessionImportSource.Type;

export const AgentSessionScanInput = Schema.Struct({});
export type AgentSessionScanInput = typeof AgentSessionScanInput.Type;

export const AgentSessionProjectGit = Schema.Struct({
  remoteKey: Schema.NullOr(Schema.String),
  repository: Schema.NullOr(Schema.String),
});
export type AgentSessionProjectGit = typeof AgentSessionProjectGit.Type;

export const AgentSessionProjectCandidate = Schema.Struct({
  path: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  projectId: Schema.optional(ProjectId),
  sources: Schema.Array(AgentSessionSource),
  threadCount: NonNegativeInt,
  lastActiveAt: Schema.NullOr(IsoDateTime),
  alreadyImported: Schema.Boolean,
  git: Schema.optionalKey(Schema.NullOr(AgentSessionProjectGit)),
});
export type AgentSessionProjectCandidate = typeof AgentSessionProjectCandidate.Type;

export const AgentSessionScanResult = Schema.Struct({
  candidates: Schema.Array(AgentSessionProjectCandidate),
  scannedAt: IsoDateTime,
  truncated: Schema.optional(Schema.Boolean),
});
export type AgentSessionScanResult = typeof AgentSessionScanResult.Type;

export const AgentSessionImportInput = Schema.Struct({
  projectId: ProjectId,
  expectedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
});
export type AgentSessionImportInput = typeof AgentSessionImportInput.Type;

export class AgentSessionImportProjectNotFoundError extends Schema.TaggedError<AgentSessionImportProjectNotFoundError>()(
  "AgentSessionImportProjectNotFoundError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project '${this.projectId}' does not exist.`;
  }
}

export class AgentSessionImportProjectChangedError extends Schema.TaggedError<AgentSessionImportProjectChangedError>()(
  "AgentSessionImportProjectChangedError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project '${this.projectId}' changed directories. Scan for projects again before importing history.`;
  }
}

export const AgentSessionImportResult = Schema.Struct({
  importedCount: NonNegativeInt,
  skippedCount: NonNegativeInt,
});
export type AgentSessionImportResult = typeof AgentSessionImportResult.Type;

export const ClaudeSessionSearchInput = Schema.Struct({
  query: TrimmedNonEmptyString,
});
export type ClaudeSessionSearchInput = typeof ClaudeSessionSearchInput.Type;

export const ClaudeSessionCandidate = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
  /** The project whose folder the session ran in; import needs one. */
  projectId: Schema.NullOr(ProjectId),
});
export type ClaudeSessionCandidate = typeof ClaudeSessionCandidate.Type;

export const ClaudeSessionSearchResult = Schema.Struct({
  sessions: Schema.Array(ClaudeSessionCandidate),
});
export type ClaudeSessionSearchResult = typeof ClaudeSessionSearchResult.Type;

export const ClaudeSessionImportInput = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
});
export type ClaudeSessionImportInput = typeof ClaudeSessionImportInput.Type;

export const ClaudeSessionImportResult = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
});
export type ClaudeSessionImportResult = typeof ClaudeSessionImportResult.Type;

export class ClaudeSessionNotFoundError extends Schema.TaggedError<ClaudeSessionNotFoundError>()(
  "ClaudeSessionNotFoundError",
  { sessionId: Schema.String },
) {
  override get message(): string {
    return `No readable Claude session '${this.sessionId}' was found.`;
  }
}

export class ClaudeSessionProjectNotFoundError extends Schema.TaggedError<ClaudeSessionProjectNotFoundError>()(
  "ClaudeSessionProjectNotFoundError",
  { cwd: Schema.String },
) {
  override get message(): string {
    return `Add '${this.cwd}' as a project before importing its Claude session.`;
  }
}

export class ClaudeSessionInUseError extends Schema.TaggedError<ClaudeSessionInUseError>()(
  "ClaudeSessionInUseError",
  { sessionId: Schema.String },
) {
  override get message(): string {
    return `Claude session '${this.sessionId}' already belongs to another thread.`;
  }
}

export class AgentSessionScanError extends Schema.TaggedError<AgentSessionScanError>()(
  "AgentSessionScanError",
  {
    operation: Schema.Literals(["read-settings", "read-projects", "import-session"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to scan agent sessions during ${this.operation}.`;
  }
}
