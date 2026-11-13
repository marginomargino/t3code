import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { orchestrationEnvironment } from "../../state/orchestration";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";

export function useFinalizeFork(environmentId: EnvironmentId) {
  const finalize = useAtomCommand(orchestrationEnvironment.finalizeFork);
  const canFinalize = useAtomValue(
    orchestrationEnvironment.finalizeFork.permissionAtom(environmentId),
  );
  const finalizeFork = async (threadId: ThreadId) => {
    const result = await finalize({ environmentId, input: { threadId } });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not finalize the fork",
        description: error instanceof Error ? error.message : undefined,
      });
      return;
    }
    toastManager.add({
      type: "info",
      title: "Finalizing fork",
      description:
        "The agent is writing a recap. It reaches the parent thread with your next message there, and this fork will be settled.",
    });
  };
  return { canFinalize, finalizeFork };
}
