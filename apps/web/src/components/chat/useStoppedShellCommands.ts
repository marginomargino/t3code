import { stopComposerShellCommands } from "@t3tools/client-runtime/user-shell-command";
import { type EnvironmentId, MessageId, type TurnItemId } from "@t3tools/contracts";
import { shellCommandMessageText } from "@t3tools/shared/shellCommand";
import { useState } from "react";

import {
  type ComposerThreadTarget,
  composerDraftHasUserContent,
  composerTargetKey,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import type { ChatMessage } from "../../types";

const NO_STOPPED_COMMANDS: ReadonlyArray<ChatMessage> = [];

/** `messages` with `stopped` among them, oldest first, for prompt history. */
export function withStoppedShellCommands(
  messages: ReadonlyArray<ChatMessage>,
  stopped: ReadonlyArray<ChatMessage>,
): ReadonlyArray<ChatMessage> {
  return stopped.length === 0
    ? messages
    : [...messages, ...stopped].toSorted((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      );
}

/**
 * A running `! cmd` the person stopped comes back to them, as in Claude Code: into an empty
 * composer in shell mode, to edit or run again, or, rather than replace a draft, into the prompt
 * history, where Up recalls it. The agent never saw the command, so only this client keeps it.
 */
export function useStoppedShellCommands(input: {
  readonly environmentId: EnvironmentId;
  readonly composerDraftTarget: ComposerThreadTarget;
  /**
   * False while the composer holds a queued message's edit, which a command must not replace, or
   * where commands can no longer be sent.
   */
  readonly composerAvailable: boolean;
  /** Whether `command` went into `target`'s composer; false once the view shows another draft. */
  readonly placeInComposer: (target: ComposerThreadTarget, command: string) => boolean;
  /** Terminal access, which a command's own Stop needs too. */
  readonly canStopCommands: boolean;
}) {
  const [historyByTarget, setHistoryByTarget] = useState<
    ReadonlyMap<string, ReadonlyArray<ChatMessage>>
  >(() => new Map());
  const history =
    historyByTarget.get(composerTargetKey(input.composerDraftTarget)) ?? NO_STOPPED_COMMANDS;

  /** `target` is the composer the command was stopped from, which may no longer be shown. */
  const returnStoppedCommand = (
    command: string,
    itemId: TurnItemId,
    target: ComposerThreadTarget,
  ) => {
    const draft = useComposerDraftStore.getState().getComposerDraft(target);
    if (
      input.composerAvailable &&
      !composerDraftHasUserContent(draft) &&
      input.placeInComposer(target, command)
    ) {
      return;
    }
    const targetKey = composerTargetKey(target);
    const now = new Date().toISOString();
    const message: ChatMessage = {
      id: MessageId.make(`stopped-shell-command:${itemId}`),
      role: "user",
      text: shellCommandMessageText(command),
      shellCommand: true,
      shellCommandStopped: true,
      createdBy: "user",
      runId: null,
      streaming: false,
      createdAt: now,
      updatedAt: now,
    };
    setHistoryByTarget((previous) =>
      new Map(previous).set(targetKey, [...(previous.get(targetKey) ?? []), message]),
    );
  };

  // Stops settle after later renders; the command returns as the composer is by then.
  const returnStoppedCommandLatest = useStableCallback(returnStoppedCommand);
  const stopCommand = useAtomCommand(threadEnvironment.stopUserShellCommand);

  /**
   * The composer's Stop, and its shortcut, while the thread's commands are all it does: they stop
   * as their own Stop would. False where Stop interrupts the thread instead.
   */
  const stopCommandsInsteadOfThread = (
    projection: Parameters<typeof stopComposerShellCommands>[0]["projection"],
  ): boolean => {
    if (!input.canStopCommands) return false;
    const target = input.composerDraftTarget;
    const stopping = stopComposerShellCommands({
      projection,
      stop: async (command) =>
        (
          await stopCommand({
            environmentId: input.environmentId,
            input: { threadId: command.threadId, turnItemId: command.id },
          })
        )._tag === "Success",
      onStoppedRunning: (command) => returnStoppedCommandLatest(command.input, command.id, target),
    });
    return stopping !== null;
  };

  const withStoppedCommands = (messages: ReadonlyArray<ChatMessage>) =>
    withStoppedShellCommands(messages, history);

  return {
    returnStoppedCommand,
    stopCommandsInsteadOfThread,
    stoppedCommands: history,
    withStoppedCommands,
  };
}
