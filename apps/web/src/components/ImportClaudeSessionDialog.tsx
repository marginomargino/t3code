import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ClaudeSessionCandidate, EnvironmentId } from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import { Atom } from "effect/reactivity";
import { useRef, useState } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { claudeSessionImport, claudeSessionSearch } from "../state/agentSessions";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";

// Hosted at the root so it survives command palette dismissal.
const importClaudeSessionEnvironmentAtom = Atom.make<EnvironmentId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("agent-sessions:import-claude-dialog-environment"),
);

export function openImportClaudeSessionDialog(environmentId: EnvironmentId): void {
  appAtomRegistry.set(importClaudeSessionEnvironmentAtom, environmentId);
}

function closeImportClaudeSessionDialog(): void {
  appAtomRegistry.set(importClaudeSessionEnvironmentAtom, null);
}

export function ImportClaudeSessionDialogHost() {
  const environmentId = useAtomValue(importClaudeSessionEnvironmentAtom);
  if (environmentId === null) return null;
  return <ImportClaudeSessionDialog key={environmentId} environmentId={environmentId} />;
}

function failureMessage(result: { readonly cause: Cause.Cause<unknown> }, fallback: string) {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

function ImportClaudeSessionDialog({ environmentId }: { environmentId: EnvironmentId }) {
  const navigate = useNavigate();
  const search = useAtomCommand(claudeSessionSearch, { reportFailure: false });
  const importSession = useAtomCommand(claudeSessionImport, { reportFailure: false });
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{
    readonly sessions: ReadonlyArray<ClaudeSessionCandidate>;
    readonly searchedAtMs: number;
  } | null>(null);
  const [searching, setSearching] = useState(false);
  const [importingId, setImportingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = searching || importingId !== null;

  const submitSearch = async () => {
    const trimmed = query.trim();
    if (trimmed.length === 0 || busy) return;
    setError(null);
    setSearching(true);
    const result = await search({ environmentId, input: { query: trimmed } });
    setSearching(false);
    if (result._tag === "Success") {
      setResults({ sessions: result.value.sessions, searchedAtMs: Date.now() });
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    setError(failureMessage(result, "Could not search Claude sessions."));
  };

  const runImport = async (sessionId: string) => {
    if (busy) return;
    setError(null);
    setImportingId(sessionId);
    const result = await importSession({ environmentId, input: { sessionId } });
    setImportingId(null);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      setError(failureMessage(result, "Could not import the Claude session."));
      return;
    }
    closeImportClaudeSessionDialog();
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, result.value.threadId)),
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && importingId === null) closeImportClaudeSessionDialog();
      }}
    >
      <DialogPopup className="max-w-xl" initialFocus={inputRef}>
        <DialogHeader>
          <DialogTitle>Import Claude session</DialogTitle>
          <DialogDescription>
            Find a Claude Code session by its ID or title and continue it as a thread.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex gap-2">
            <Input
              ref={inputRef}
              placeholder="Session ID or title"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                void submitSearch();
              }}
            />
            <Button
              type="button"
              size="sm"
              onClick={() => void submitSearch()}
              disabled={busy || query.trim().length === 0}
            >
              {searching ? "Searching..." : "Search"}
            </Button>
          </div>
          {error ? <p className="text-destructive text-xs">{error}</p> : null}
          {results === null ? null : results.sessions.length === 0 ? (
            <p className="text-muted-foreground text-sm">No matching Claude sessions.</p>
          ) : (
            <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto">
              {results.sessions.map((session) => (
                <li
                  key={session.sessionId}
                  className="flex items-center gap-3 rounded-md border px-3 py-2"
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <p className="truncate font-medium text-sm">{session.title}</p>
                    <p className="truncate text-muted-foreground text-xs">
                      {session.cwd} ·{" "}
                      {formatRelativeTimeLabel(session.updatedAt, results.searchedAtMs)}
                    </p>
                    {session.projectId === null ? (
                      <p className="text-muted-foreground text-xs">
                        Add this folder as a project first
                      </p>
                    ) : null}
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void runImport(session.sessionId)}
                    disabled={busy || session.projectId === null}
                  >
                    {importingId === session.sessionId ? "Importing..." : "Import"}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
