import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { newThreadId } from "~/lib/utils";
import { waitForThreadShell } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { useStableCallback } from "./useStableCallback";

export interface ForkThreadRequest {
  readonly environmentId: EnvironmentId;
  readonly sourceThreadId: ThreadId;
  readonly sourceTitle: string;
  /** Omit to fork from the thread's latest completed run. */
  readonly runId?: RunId;
}

/** Creates the fork, waits for its shell to stream in, then opens it. Resolves to an error message, or null. */
export function useForkThread() {
  const navigate = useNavigate();
  const forkFromRun = useAtomCommand(threadEnvironment.forkFromRun, { reportFailure: false });
  const forkLatest = useAtomCommand(threadEnvironment.forkLatest, { reportFailure: false });

  return useStableCallback(async (request: ForkThreadRequest): Promise<string | null> => {
    const { environmentId, sourceThreadId, runId } = request;
    const targetThreadId = newThreadId();
    const targetThreadRef = scopeThreadRef(environmentId, targetThreadId);
    const title = `${request.sourceTitle} fork`;
    const result =
      runId === undefined
        ? await forkLatest({ environmentId, input: { sourceThreadId, targetThreadId, title } })
        : await forkFromRun({
            environmentId,
            input: { sourceThreadId, targetThreadId, runId, title },
          });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return null;
      const error = squashAtomCommandFailure(result);
      if (error instanceof Error) return error.message;
      return runId === undefined ? "Failed to fork this thread." : "Failed to fork this response.";
    }
    if (!(await waitForThreadShell(targetThreadRef))) {
      return "The fork was created, but its thread data did not reach this client. Reconnect and try opening it from the sidebar.";
    }
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(targetThreadRef),
    });
    return null;
  });
}
