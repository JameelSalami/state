import { Context, type Effect } from "effect";

import type { SemanticDigest } from "./canonical.js";
import type {
  StateMap,
  StateMapPointer,
  StateRecord,
  StoredMap,
  StoredRecord
} from "./model.js";
import type {
  StateRuntimeConflict,
  StateRuntimeCorrupt,
  StateRuntimeReadError,
  StateRuntimeValidationError,
  StateRuntimeWriteError
} from "./errors.js";

export type StateRuntimeFailure =
  | StateRuntimeValidationError
  | StateRuntimeWriteError
  | StateRuntimeReadError
  | StateRuntimeCorrupt;

export type StateRuntimeVerificationScope = "current" | "history";

export interface StateRuntimeHealth {
  readonly state: "Healthy";
  readonly project: string;
  readonly generation: number;
  readonly map: SemanticDigest;
  readonly entries: number;
  readonly mechanism: string;
}

export interface StateRuntimeVerification extends StateRuntimeHealth {
  readonly scope: StateRuntimeVerificationScope;
  readonly maps: number;
  readonly records: number;
}

export interface StateRuntimeStorageVerification {
  readonly state: "Healthy";
  readonly mechanism: string;
}

export interface StateRuntimeEntry {
  readonly pointer: StateMapPointer;
  readonly id: string;
  readonly kind: string;
  readonly record: StoredRecord;
}

export interface StateRuntimeCurrentEntry extends StateRuntimeEntry {}

export interface StateRuntimeCommit {
  readonly expected: StateMapPointer | null;
  readonly records: readonly StateRecord[];
  readonly map: StateMap;
}

export interface StateRuntimeStore {
  readonly projectId: string;
  readonly mechanismId: string;

  readonly putRecord: (
    record: StateRecord
  ) => Effect.Effect<SemanticDigest, StateRuntimeFailure>;

  readonly getRecord: (
    digest: SemanticDigest
  ) => Effect.Effect<StoredRecord, StateRuntimeFailure>;

  readonly putMap: (
    map: StateMap
  ) => Effect.Effect<SemanticDigest, StateRuntimeFailure>;

  readonly getMap: (
    digest: SemanticDigest
  ) => Effect.Effect<StoredMap, StateRuntimeFailure>;

  readonly current: Effect.Effect<StateMapPointer | null, StateRuntimeFailure>;

  /**
   * Strict ordinary advancement. Empty-store advancement is genesis only
   * (generation 0, parent null); an existing current may advance exactly one
   * generation and the next map must name the expected map as its parent.
   */
  readonly compareAndSwapCurrent: (
    expected: StateMapPointer | null,
    next: StateMapPointer
  ) => Effect.Effect<void, StateRuntimeFailure | StateRuntimeConflict>;

  /**
   * Atomically persist consumer-compiled immutable objects and perform the
   * same strict ordinary advancement law as compareAndSwapCurrent.
   */
  readonly commit: (
    input: StateRuntimeCommit
  ) => Effect.Effect<StateMapPointer, StateRuntimeFailure | StateRuntimeConflict>;

  /**
   * Recovery-only seam for an empty store. The adapter verifies the complete
   * reachable history and referenced records before installing the supplied
   * head, so multi-generation snapshot restore does not weaken ordinary CAS.
   */
  readonly installVerifiedHistory: (
    current: StateMapPointer
  ) => Effect.Effect<void, StateRuntimeFailure | StateRuntimeConflict>;

  /**
   * Resolve one entry from the canonical current StateMap and its referenced
   * record without requiring consumers to materialize every current record.
   */
  readonly getCurrentEntry: (
    id: string
  ) => Effect.Effect<StateRuntimeCurrentEntry | null, StateRuntimeFailure>;

  /** Resolve the newest reachable occurrence of one entry across current history. */
  readonly getLatestEntry: (
    id: string
  ) => Effect.Effect<StateRuntimeEntry | null, StateRuntimeFailure>;

  readonly history: (
    limit?: number
  ) => Effect.Effect<readonly StateMapPointer[], StateRuntimeFailure>;

  /** Backward-compatible current-scope verification with the v1 result shape. */
  readonly verify: Effect.Effect<StateRuntimeHealth, StateRuntimeFailure>;

  readonly verifyCurrent: Effect.Effect<
    StateRuntimeVerification,
    StateRuntimeFailure
  >;

  readonly verifyHistory: Effect.Effect<
    StateRuntimeVerification,
    StateRuntimeFailure
  >;

  /** Explicit physical/mechanism integrity check; intentionally not part of hot-path logical verification. */
  readonly verifyStorage: Effect.Effect<
    StateRuntimeStorageVerification,
    StateRuntimeFailure
  >;

  readonly close: Effect.Effect<void, StateRuntimeWriteError>;
}

export const StateRuntimeStore = Context.GenericTag<StateRuntimeStore>(
  "state/StateRuntimeStore"
);
