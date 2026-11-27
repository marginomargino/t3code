import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { usePinnedMessageStore } from "../../pinnedMessageStore";
import { MessagePinButton } from "./MessagePinButton";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("pins") };
const pinned = () => usePinnedMessageStore.getState().byThreadKey[scopedThreadKey(threadRef)];

it("pins, replaces with another message, and unpins the pinned one", async () => {
  using _cleanup = {
    [Symbol.dispose]: () => usePinnedMessageStore.getState().removeThread(threadRef),
  };
  await using screen = await render(
    <>
      <div data-testid="a">
        <MessagePinButton
          threadRef={threadRef}
          messageId={MessageId.make("a")}
          text="Case A"
          role="assistant"
        />
      </div>
      <div data-testid="b">
        <MessagePinButton
          threadRef={threadRef}
          messageId={MessageId.make("b")}
          text="Case B"
          role="user"
        />
      </div>
    </>,
  );
  const a = screen.getByTestId("a").getByRole("button");
  const b = screen.getByTestId("b").getByRole("button");

  await a.click();
  expect(pinned()).toEqual({ messageId: "a", text: "Case A", role: "assistant" });
  await expect.element(a).toHaveAccessibleName("Unpin message");

  await b.click();
  expect(pinned()).toEqual({ messageId: "b", text: "Case B", role: "user" });
  await expect.element(a).toHaveAccessibleName("Pin message");

  await b.click();
  expect(pinned()).toBeUndefined();
});
