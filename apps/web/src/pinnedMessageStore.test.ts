import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { usePinnedMessageStore } from "./pinnedMessageStore";

it("replaces a thread's pin, unpins it, and clears it when the thread is removed", () => {
  const threadId = ThreadId.make("thread");
  const thread = { environmentId: EnvironmentId.make("env"), threadId };
  const remoteThread = { environmentId: EnvironmentId.make("remote"), threadId };
  const original = {
    messageId: MessageId.make("cases"),
    text: "Cases\n\n1. CASE-42",
    role: "assistant" as const,
  };
  const replacement = {
    messageId: MessageId.make("question"),
    text: "What about CASE-42?",
    role: "user" as const,
  };
  const threadPin = () => usePinnedMessageStore.getState().byThreadKey[scopedThreadKey(thread)];
  const store = usePinnedMessageStore.getState();

  store.pin(thread, original);
  expect(threadPin()).toEqual({
    messageId: "cases",
    text: "Cases\n\n1. CASE-42",
    role: "assistant",
  });

  store.pin(remoteThread, original);
  store.pin(thread, replacement);
  expect(threadPin()).toEqual({
    messageId: "question",
    text: "What about CASE-42?",
    role: "user",
  });

  store.unpin(thread);
  expect(threadPin()).toBeUndefined();

  store.pin(thread, original);
  store.removeThread(thread);
  expect(threadPin()).toBeUndefined();
  expect(usePinnedMessageStore.getState().byThreadKey[scopedThreadKey(remoteThread)]).toEqual({
    messageId: "cases",
    text: "Cases\n\n1. CASE-42",
    role: "assistant",
  });
  store.removeThread(remoteThread);
});
