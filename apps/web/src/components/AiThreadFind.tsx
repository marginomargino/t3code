import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { msg, T, useGT, Var } from "gt-react";
import { XIcon } from "lucide-react";

import {
  dismissAiThreadFind,
  setAiThreadFindResultsOpen,
  settleAiThreadFind,
  startAiThreadFind,
  useAiThreadFindStore,
} from "../aiThreadFindStore";
import { useThreadActions } from "../hooks/useThreadActions";
import { m } from "../i18n/messages";
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
        : { error: m(msg("The model could not search your threads.")) },
    );
    if (!settled) return;
    const { matches, error } = useAiThreadFindStore.getState();
    if (error !== null) {
      announce({ type: "error", title: m(msg("AI thread search failed")), description: error });
      return;
    }
    if (matches.length === 0) {
      announce({
        type: "info",
        title: m(msg("No matching threads")),
        description: m(
          msg("Nothing in the last two months fits “{description}”.", { description }),
        ),
      });
      return;
    }
    announce({
      type: "success",
      title: m(
        msg("{count, plural, one {Found {count} thread} other {Found {count} threads}}", {
          count: matches.length,
        }),
      ),
      description,
      data: { hideCopyButton: true },
      actionProps: {
        children: m(msg("Show", { $context: "verb, reveals search results" })),
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
  const gt = useGT();
  if (status === "running") {
    return (
      <p className="truncate px-2 pb-1 text-xs text-muted-foreground">
        <T>
          AI search: <Var>{description}</Var>…
        </T>
      </p>
    );
  }
  if (status === "done" && matchCount > 0) {
    return (
      <div className="flex items-center gap-1 px-2 pb-1">
        <Button variant="ghost" size="xs" onClick={() => setAiThreadFindResultsOpen(true)}>
          {gt("{count, plural, one {{count} AI match · Show} other {{count} AI matches · Show}}", {
            count: matchCount,
          })}
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={gt("Dismiss AI matches")}
          onClick={dismissAiThreadFind}
        >
          <XIcon />
        </Button>
      </div>
    );
  }
  if (props.query.trim().length < AI_THREAD_FIND_MIN_LENGTH) return null;
  return (
    <p className="px-2 pb-1 text-xs text-muted-foreground">
      <T>Shift+Tab to search by meaning</T>
    </p>
  );
}

export function AiThreadFindResults(props: {
  readonly onOpenThread: (threadRef: ScopedThreadRef) => void;
}) {
  const open = useAiThreadFindStore((state) => state.resultsOpen);
  const description = useAiThreadFindStore((state) => state.description);
  const matches = useAiThreadFindStore((state) => state.matches);
  const environmentId = useAiThreadFindStore((state) => state.environmentId);
  const { unarchiveThread } = useThreadActions();
  const gt = useGT();
  return (
    <Dialog open={open} onOpenChange={setAiThreadFindResultsOpen}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            <T>Matching threads</T>
          </DialogTitle>
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
                        toastManager.add({
                          type: "error",
                          title: gt("Could not unarchive thread"),
                        });
                      }
                    });
                  }}
                >
                  <span className="truncate text-sm font-medium">
                    {match.archived
                      ? gt("{title} (archived)", { title: match.title })
                      : match.title}
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
