import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

import {
  setAiThreadFindResultsOpen,
  settleAiThreadFind,
  startAiThreadFind,
  useAiThreadFindStore,
} from "../aiThreadFindStore";
import { useThreadActions } from "../hooks/useThreadActions";
import { orchestrationEnvironment } from "../state/orchestration";
import { useAtomCommand } from "../state/use-atom-command";
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
import { toastManager } from "./ui/toast";

export const AI_THREAD_FIND_MIN_LENGTH = 3;
export const AI_THREAD_FIND_MAX_LENGTH = 500;

// The last search's toast, closed when a newer search replaces it.
let announcement: string | null = null;

const announce = (toast: Parameters<typeof toastManager.add>[0]) => {
  announcement = toastManager.add(toast);
};

/** Runs a by-description search in the background and announces it with a toast. */
export function useStartAiThreadFind() {
  const findThreads = useAtomCommand(orchestrationEnvironment.findThreadsByDescription, {
    reportFailure: false,
  });
  return async (description: string, environmentId: EnvironmentId) => {
    if (announcement !== null) toastManager.close(announcement);
    announcement = null;
    const run = startAiThreadFind(description, environmentId);
    const result = await findThreads({ environmentId, input: { description } });
    const settled = settleAiThreadFind(
      run,
      result._tag === "Success"
        ? { matches: result.value.matches }
        : { error: "The model could not search your threads." },
    );
    if (!settled) return;
    const { matches, error } = useAiThreadFindStore.getState();
    if (error !== null) {
      announce({ type: "error", title: "AI thread search failed", description: error });
      return;
    }
    if (matches.length === 0) {
      announce({
        type: "info",
        title: "No matching threads",
        description: `Nothing in the last two months fits “${description}”.`,
      });
      return;
    }
    announce({
      type: "success",
      title: `Found ${matches.length} ${matches.length === 1 ? "thread" : "threads"}`,
      description,
      data: { hideCopyButton: true },
      actionProps: {
        children: "Show",
        onClick: () => {
          if (announcement !== null) toastManager.close(announcement);
          // A newer search closes this toast, but a click can race that close.
          if (useAiThreadFindStore.getState().run === run) setAiThreadFindResultsOpen(true);
        },
      },
    });
  };
}

/** The running search or the last results, else a hint that Shift+Tab searches by meaning. */
export function AiThreadFindStatus(props: { readonly query: string }) {
  const status = useAiThreadFindStore((state) => state.status);
  const description = useAiThreadFindStore((state) => state.description);
  const matchCount = useAiThreadFindStore((state) => state.matches.length);
  if (status === "running") {
    return (
      <p className="truncate px-2 pb-1 text-xs text-muted-foreground">AI search: {description}…</p>
    );
  }
  if (status === "done" && matchCount > 0) {
    return (
      <div className="px-2 pb-1">
        <Button variant="ghost" size="xs" onClick={() => setAiThreadFindResultsOpen(true)}>
          {matchCount} AI {matchCount === 1 ? "match" : "matches"} · Show
        </Button>
      </div>
    );
  }
  if (props.query.trim().length < AI_THREAD_FIND_MIN_LENGTH) return null;
  return <p className="px-2 pb-1 text-xs text-muted-foreground">Shift+Tab to search by meaning</p>;
}

export function AiThreadFindResults(props: {
  readonly onOpenThread: (threadRef: ScopedThreadRef) => void;
}) {
  const open = useAiThreadFindStore((state) => state.resultsOpen);
  const description = useAiThreadFindStore((state) => state.description);
  const matches = useAiThreadFindStore((state) => state.matches);
  const environmentId = useAiThreadFindStore((state) => state.environmentId);
  const { unarchiveThread } = useThreadActions();
  return (
    <Dialog open={open} onOpenChange={setAiThreadFindResultsOpen}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Matching threads</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <ul className="flex flex-col gap-1">
            {matches.map((match) => (
              <li key={match.threadId}>
                <button
                  type="button"
                  className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-accent"
                  onClick={() => {
                    if (environmentId === null) return;
                    setAiThreadFindResultsOpen(false);
                    const threadRef = scopeThreadRef(environmentId, match.threadId);
                    // An archived thread's route redirects home, so it comes back first.
                    if (!match.archived) return props.onOpenThread(threadRef);
                    void unarchiveThread(threadRef, { navigate: true }).then((result) => {
                      if (result._tag === "Failure") {
                        toastManager.add({ type: "error", title: "Could not unarchive thread" });
                      }
                    });
                  }}
                >
                  <span className="truncate text-sm font-medium">
                    {match.title}
                    {match.archived ? " (archived)" : ""}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {match.projectTitle} · {formatRelativeTimeLabel(match.updatedAt)}
                  </span>
                  <span className="text-sm">{match.recap}</span>
                  <span className="text-xs text-muted-foreground">{match.reason}</span>
                </button>
              </li>
            ))}
          </ul>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
