import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { readProject, readThreadShell } from "../state/entities";
import { serverEnvironment } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";

/** Stops the thread's provider process so the next message resumes it with fresh skills, plugins, and MCP servers. Throws when the stop fails. */
export function useRestartAgentSession() {
  const stopThreadSession = useAtomCommand(threadEnvironment.stopSession, {
    reportFailure: false,
  });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });

  return async (threadRef: ScopedThreadRef) => {
    const thread = readThreadShell(threadRef);
    if (!thread) return;
    const { environmentId } = threadRef;
    if (thread.runtime !== null) {
      const stopped = await stopThreadSession({
        environmentId,
        input: { threadId: thread.id },
      });
      if (stopped._tag === "Failure") {
        if (isAtomCommandInterrupted(stopped)) return;
        throw squashAtomCommandFailure(stopped);
      }
    }
    toastManager.add({
      type: "success",
      title: "Agent session will restart",
      description: "Your next message starts a fresh session.",
    });
    const project = readProject(scopeProjectRef(environmentId, thread.projectId));
    if (!project) return;
    const refreshed = await refreshProviders({
      environmentId,
      input: {
        instanceId: thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId,
        cwd: thread.worktreePath ?? project.workspaceRoot,
        fresh: true,
      },
    });
    // The session is already stopped, so a refresh failure is reported on its own, not as a failed restart.
    if (refreshed._tag === "Failure" && !isAtomCommandInterrupted(refreshed)) {
      const error = squashAtomCommandFailure(refreshed);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to refresh providers",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  };
}
