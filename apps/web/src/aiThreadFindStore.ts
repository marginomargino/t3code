import type { EnvironmentId, OrchestrationFoundThread } from "@t3tools/contracts";
import { create } from "zustand";

export interface AiThreadFindState {
  /** Increments per search, so an answer for a replaced search is ignored. */
  readonly run: number;
  readonly status: "idle" | "running" | "done" | "failed";
  readonly description: string;
  readonly environmentId: EnvironmentId | null;
  readonly matches: ReadonlyArray<OrchestrationFoundThread>;
  readonly error: string | null;
  readonly resultsOpen: boolean;
}

const INITIAL_STATE: AiThreadFindState = {
  run: 0,
  status: "idle",
  description: "",
  environmentId: null,
  matches: [],
  error: null,
  resultsOpen: false,
};

export const useAiThreadFindStore = create<AiThreadFindState>(() => INITIAL_STATE);

/** Starts a search, replacing any running one; returns its run for `settleAiThreadFind`. */
export function startAiThreadFind(description: string, environmentId: EnvironmentId): number {
  const run = useAiThreadFindStore.getState().run + 1;
  useAiThreadFindStore.setState({
    run,
    status: "running",
    description,
    environmentId,
    matches: [],
    error: null,
    resultsOpen: false,
  });
  return run;
}

/** Records a search's outcome; false when a newer search replaced it. */
export function settleAiThreadFind(
  run: number,
  outcome:
    | { readonly matches: ReadonlyArray<OrchestrationFoundThread> }
    | { readonly error: string },
): boolean {
  if (useAiThreadFindStore.getState().run !== run) return false;
  useAiThreadFindStore.setState(
    "error" in outcome
      ? { status: "failed", error: outcome.error, matches: [] }
      : { status: "done", error: null, matches: outcome.matches },
  );
  return true;
}

export function setAiThreadFindResultsOpen(resultsOpen: boolean): void {
  useAiThreadFindStore.setState({ resultsOpen });
}

/** Drops the last results; the new run also makes an open toast's Show a no-op. */
export function dismissAiThreadFind(): void {
  useAiThreadFindStore.setState((state) => ({ ...INITIAL_STATE, run: state.run + 1 }));
}
