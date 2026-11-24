import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { usePinnedMessageStore } from "../../pinnedMessageStore";
import { PinnedMessageBar, type PinnedMessageBarProps } from "./PinnedMessageBar";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

function PinnedMessageFixture({ onJump }: { onJump: PinnedMessageBarProps["onJump"] }) {
  const snapshot = usePinnedMessageStore((store) => store.byThreadKey[scopedThreadKey(threadRef)]);
  if (!snapshot) return null;
  return (
    <PinnedMessageBar
      snapshot={snapshot}
      threadRef={threadRef}
      markdownCwd={undefined}
      skills={[]}
      onJump={onJump}
      onUnpin={() => usePinnedMessageStore.getState().unpin(threadRef)}
    />
  );
}

it("labels the strip with the first prose line, skipping a code fence", async () => {
  usePinnedMessageStore.getState().pin(threadRef, {
    messageId: MessageId.make("fenced"),
    text: "```ts\nconst a = 1\n```",
    role: "assistant",
  });
  using _pin = {
    [Symbol.dispose]: () => usePinnedMessageStore.getState().removeThread(threadRef),
  };
  await using screen = await render(<PinnedMessageFixture onJump={undefined} />);
  await expect.element(screen.getByRole("button", { name: "const a = 1" })).toBeVisible();
});

it("keeps a pinned user message's explicit list numbers", async () => {
  usePinnedMessageStore.getState().pin(threadRef, {
    messageId: MessageId.make("user-cases"),
    text: "3. Case A\n5. Case B",
    role: "user",
  });
  using _pin = {
    [Symbol.dispose]: () => usePinnedMessageStore.getState().removeThread(threadRef),
  };
  await using screen = await render(<PinnedMessageFixture onJump={undefined} />);
  await screen.getByRole("button", { name: "3. Case A" }).click();

  const region = screen.getByRole("region", { name: "Pinned message" });
  const list = region.element().querySelector("ol");
  expect(list?.getAttribute("start")).toBe("3");
  expect(
    [...(list?.querySelectorAll("li") ?? [])].map((item) => item.getAttribute("value")),
  ).toEqual([null, "5"]);
});

it("reads the snapshot, dispatches jump and collapses, and clears the pin", async () => {
  usePinnedMessageStore.getState().pin(threadRef, {
    messageId: MessageId.make("cases"),
    text: "\n\nCases to review\n\n1. `CASE-42`\n2. `CASE-71`",
    role: "assistant",
  });
  using _pin = {
    [Symbol.dispose]: () => usePinnedMessageStore.getState().removeThread(threadRef),
  };
  const onJump = vi.fn();
  await using screen = await render(<PinnedMessageFixture onJump={undefined} />);
  const toggle = screen.getByRole("button", { name: "Cases to review" });
  const jump = screen.getByRole("button", { name: "Jump to message" });

  await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
  await expect.element(screen.getByText("CASE-42")).not.toBeInTheDocument();
  await expect.element(jump).not.toBeInTheDocument();

  await toggle.click();
  await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
  await expect.element(screen.getByText("CASE-42")).toBeVisible();
  await expect.element(screen.getByText("CASE-71")).toBeVisible();

  await screen.rerender(<PinnedMessageFixture onJump={onJump} />);
  await jump.click();
  expect(onJump).toHaveBeenCalledTimes(1);
  await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
  await expect.element(screen.getByText("CASE-42")).not.toBeInTheDocument();

  await screen.getByRole("button", { name: "Unpin message" }).click();
  await expect
    .element(screen.getByRole("region", { name: "Pinned message" }))
    .not.toBeInTheDocument();
  expect(usePinnedMessageStore.getState().byThreadKey[scopedThreadKey(threadRef)]).toBeUndefined();
});
