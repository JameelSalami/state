import { Effect } from "effect";

import type { SemanticDigest } from "./canonical.js";
import { StateRuntimeCorrupt } from "./errors.js";
import { makeMemoryStateStore } from "./adapters/memory.js";
import { makeStateMap, type StateMapPointer } from "./model.js";
import { exportStateRuntimeSnapshot, type StateRuntimeSnapshot } from "./snapshot.js";
import type { StateRuntimeStore } from "./store.js";

export interface StateCheckpointProposal {
  readonly schema: "state-runtime.checkpoint-proposal/v1";
  readonly project: string;
  readonly supersedes: StateMapPointer;
  readonly sourceMapDigest: SemanticDigest;
  readonly droppedHistoricalGenerations: number;
  readonly retainedRecords: number;
  /** Full historical verification was performed before the proposal. */
  readonly verificationScope: "history";
  /** New genesis, *not* the same historical identity as the old chain. */
  readonly snapshot: StateRuntimeSnapshot;
  readonly authority: "none";
}

/**
 * Prepare a single-generation equivalent of current materialized state.
 * Does NOT modify the live store. Applications must separately authorize any
 * destructive rewrite, retain old receipts externally, and use their own
 * lifecycle/backup controls before opting into SQLite replacement.
 *
 * The checkpoint creates a NEW history and NEW head digest, so historical
 * references to the old maps must not be presented as valid in the new store.
 */
export const prepareStateCheckpoint = (
  store: StateRuntimeStore
): Effect.Effect<StateCheckpointProposal, import("./store.js").StateRuntimeFailure | import("./errors.js").StateRuntimeConflict> =>
  Effect.gen(function*() {
    const verified = yield* store.verifyHistory;
    const pointer = yield* store.current;
    if (pointer === null) {
      return yield* Effect.fail(new StateRuntimeCorrupt({
        message: "checkpoint requires a committed current StateMap"
      }));
    }
    if (verified.map !== pointer.map || verified.generation !== pointer.generation) {
      return yield* Effect.fail(new StateRuntimeCorrupt({
        message: "head changed during checkpoint verification"
      }));
    }
    const oldMap = (yield* store.getMap(pointer.map)).value;
    const records = [];
    for (const entry of Object.values(oldMap.entries)) {
      records.push((yield* store.getRecord(entry.record)).value);
    }
    const memory = yield* makeMemoryStateStore(store.projectId);
    const checkpointMap = makeStateMap({
      project: store.projectId,
      generation: 0,
      parent: null,
      compiler: "state-runtime.checkpoint/v1",
      sourceDigest: pointer.map,
      entries: oldMap.entries
    });
    yield* memory.commit({ expected: null, records, map: checkpointMap });
    const snapshot = yield* exportStateRuntimeSnapshot(memory);
    yield* memory.close;

    // Catch an intervening writer before returning a current proposal.
    const recent = yield* store.current;
    if (recent?.map !== pointer.map || recent.generation !== pointer.generation) {
      return yield* Effect.fail(new StateRuntimeCorrupt({
        message: "head changed during checkpoint construction; retry from a new snapshot"
      }));
    }
    return {
      schema: "state-runtime.checkpoint-proposal/v1" as const,
      project: store.projectId,
      supersedes: pointer,
      sourceMapDigest: pointer.map,
      droppedHistoricalGenerations: verified.maps - 1,
      retainedRecords: records.length,
      verificationScope: "history" as const,
      snapshot,
      authority: "none" as const
    };
  });