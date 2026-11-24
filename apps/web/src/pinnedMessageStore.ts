import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { MessageId, ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export interface PinnedMessageSnapshot {
  readonly messageId: MessageId;
  readonly text: string;
  readonly role: "user" | "assistant";
}

interface PinnedMessageStoreState {
  byThreadKey: Record<string, PinnedMessageSnapshot>;
  pin: (ref: ScopedThreadRef, snapshot: PinnedMessageSnapshot) => void;
  unpin: (ref: ScopedThreadRef) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

export const usePinnedMessageStore = create<PinnedMessageStoreState>()(
  persist(
    (set) => {
      const unpin = (ref: ScopedThreadRef) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (!(threadKey in state.byThreadKey)) return state;
          const { [threadKey]: _removed, ...byThreadKey } = state.byThreadKey;
          return { byThreadKey };
        });

      return {
        byThreadKey: {},
        pin: (ref, snapshot) =>
          set((state) => ({
            byThreadKey: { ...state.byThreadKey, [scopedThreadKey(ref)]: snapshot },
          })),
        unpin,
        removeThread: unpin,
      };
    },
    {
      name: "t3code:pinned-message:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: ({ byThreadKey }) => ({ byThreadKey }),
    },
  ),
);
