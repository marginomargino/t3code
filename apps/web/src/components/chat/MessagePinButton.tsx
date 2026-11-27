import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { PinIcon, PinOffIcon } from "lucide-react";

import { usePinnedMessageStore, type PinnedMessageSnapshot } from "../../pinnedMessageStore";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function MessagePinButton({
  threadRef,
  messageId,
  text,
  role,
}: PinnedMessageSnapshot & { threadRef: ScopedThreadRef }) {
  const gt = useGT();
  const threadKey = scopedThreadKey(threadRef);
  const pinned = usePinnedMessageStore(
    (state) => state.byThreadKey[threadKey]?.messageId === messageId,
  );
  const label = pinned ? gt("Unpin message") : gt("Pin message");

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="xs"
            variant="ghost-muted"
            aria-label={label}
            onClick={() => {
              const store = usePinnedMessageStore.getState();
              if (store.byThreadKey[threadKey]?.messageId === messageId) {
                store.unpin(threadRef);
              } else {
                store.pin(threadRef, { messageId, text, role });
              }
            }}
          />
        }
      >
        {pinned ? <PinOffIcon className="size-3" /> : <PinIcon className="size-3" />}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
