import type {
  StateMap,
  StateMapPointer,
  StateRecord,
  StoredMap,
  StoredRecord
} from "./model.js";

export const STATE_RUNTIME_BRIDGE_REQUEST_SCHEMA =
  "state-runtime.bridge-request/v1" as const;
export const STATE_RUNTIME_BRIDGE_RESPONSE_SCHEMA =
  "state-runtime.bridge-response/v1" as const;

export type StateRuntimeBridgeRequest =
  | {
      readonly schema: typeof STATE_RUNTIME_BRIDGE_REQUEST_SCHEMA;
      readonly operation: "put_record";
      readonly record: StateRecord;
    }
  | {
      readonly schema: typeof STATE_RUNTIME_BRIDGE_REQUEST_SCHEMA;
      readonly operation: "get_record";
      readonly digest: string;
    }
  | {
      readonly schema: typeof STATE_RUNTIME_BRIDGE_REQUEST_SCHEMA;
      readonly operation: "put_map";
      readonly map: StateMap;
    }
  | {
      readonly schema: typeof STATE_RUNTIME_BRIDGE_REQUEST_SCHEMA;
      readonly operation: "get_map";
      readonly digest: string;
    }
  | {
      readonly schema: typeof STATE_RUNTIME_BRIDGE_REQUEST_SCHEMA;
      readonly operation: "current";
    }
  | {
      readonly schema: typeof STATE_RUNTIME_BRIDGE_REQUEST_SCHEMA;
      readonly operation: "compare_and_swap_current";
      readonly expected: StateMapPointer | null;
      readonly next: StateMapPointer;
    }
  | {
      readonly schema: typeof STATE_RUNTIME_BRIDGE_REQUEST_SCHEMA;
      readonly operation: "history";
      readonly limit?: number;
    }
  | {
      readonly schema: typeof STATE_RUNTIME_BRIDGE_REQUEST_SCHEMA;
      readonly operation: "verify";
    };

export type StateRuntimeBridgeValue =
  | string
  | null
  | StateMapPointer
  | readonly StateMapPointer[]
  | StoredRecord
  | StoredMap
  | {
      readonly state: "Healthy";
      readonly project: string;
      readonly generation: number;
      readonly map: string;
      readonly entries: number;
      readonly mechanism: string;
    };

export type StateRuntimeBridgeResponse =
  | {
      readonly schema: typeof STATE_RUNTIME_BRIDGE_RESPONSE_SCHEMA;
      readonly _tag: "Ok";
      readonly operation: StateRuntimeBridgeRequest["operation"];
      readonly value: StateRuntimeBridgeValue;
    }
  | {
      readonly schema: typeof STATE_RUNTIME_BRIDGE_RESPONSE_SCHEMA;
      readonly _tag: "Refused";
      readonly operation: string | null;
      readonly code:
        | "invalid-request"
        | "validation"
        | "read"
        | "write"
        | "corrupt"
        | "conflict"
        | "internal";
      readonly detail: string;
      readonly expectedGeneration?: number | null;
      readonly observedGeneration?: number | null;
    };
