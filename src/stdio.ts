#!/usr/bin/env node

import { Effect } from "effect";

import { isSemanticDigest } from "./canonical.js";
import {
  StateRuntimeConflict,
  StateRuntimeCorrupt,
  StateRuntimeReadError,
  StateRuntimeValidationError,
  StateRuntimeWriteError
} from "./errors.js";
import {
  validatePointer,
  validateRecord,
  validateStateMap,
  type StateMapPointer
} from "./model.js";
import {
  STATE_RUNTIME_BRIDGE_REQUEST_SCHEMA,
  STATE_RUNTIME_BRIDGE_RESPONSE_SCHEMA,
  type StateRuntimeBridgeRequest,
  type StateRuntimeBridgeResponse
} from "./stdio-protocol.js";
import { openNodeSqliteStateStore } from "./adapters/node-sqlite.js";
import type { StateRuntimeStore } from "./store.js";

class BridgeRequestError extends Error {}

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BridgeRequestError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
};

const exactKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string
): void => {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!(key in value)) {
      throw new BridgeRequestError(`${label}.${key} is required`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new BridgeRequestError(`${label}.${key} is not allowed`);
    }
  }
};

const digest = (value: unknown, label: string): string => {
  if (!isSemanticDigest(value)) {
    throw new BridgeRequestError(`${label} must be a SHA-256 semantic digest`);
  }
  return value;
};

const pointer = (value: unknown, label: string): StateMapPointer => {
  try {
    return validatePointer(value as StateMapPointer);
  } catch (cause) {
    throw new BridgeRequestError(
      `${label} is invalid: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  }
};

const parseRequest = (input: unknown): StateRuntimeBridgeRequest => {
  const root = object(input, "request");
  if (root.schema !== STATE_RUNTIME_BRIDGE_REQUEST_SCHEMA) {
    throw new BridgeRequestError(
      `request.schema must equal ${STATE_RUNTIME_BRIDGE_REQUEST_SCHEMA}`
    );
  }
  if (typeof root.operation !== "string") {
    throw new BridgeRequestError("request.operation must be a string");
  }

  switch (root.operation) {
    case "put_record":
      exactKeys(root, ["schema", "operation", "record"], [], "request");
      return {
        schema: STATE_RUNTIME_BRIDGE_REQUEST_SCHEMA,
        operation: "put_record",
        record: validateRecord(root.record as never)
      };
    case "get_record":
      exactKeys(root, ["schema", "operation", "digest"], [], "request");
      return {
        schema: STATE_RUNTIME_BRIDGE_REQUEST_SCHEMA,
        operation: "get_record",
        digest: digest(root.digest, "request.digest")
      };
    case "put_map":
      exactKeys(root, ["schema", "operation", "map"], [], "request");
      return {
        schema: STATE_RUNTIME_BRIDGE_REQUEST_SCHEMA,
        operation: "put_map",
        map: validateStateMap(root.map as never)
      };
    case "get_map":
      exactKeys(root, ["schema", "operation", "digest"], [], "request");
      return {
        schema: STATE_RUNTIME_BRIDGE_REQUEST_SCHEMA,
        operation: "get_map",
        digest: digest(root.digest, "request.digest")
      };
    case "current":
      exactKeys(root, ["schema", "operation"], [], "request");
      return { schema: STATE_RUNTIME_BRIDGE_REQUEST_SCHEMA, operation: "current" };
    case "compare_and_swap_current":
      exactKeys(
        root,
        ["schema", "operation", "expected", "next"],
        [],
        "request"
      );
      return {
        schema: STATE_RUNTIME_BRIDGE_REQUEST_SCHEMA,
        operation: "compare_and_swap_current",
        expected:
          root.expected === null
            ? null
            : pointer(root.expected, "request.expected"),
        next: pointer(root.next, "request.next")
      };
    case "history": {
      exactKeys(root, ["schema", "operation"], ["limit"], "request");
      if (
        root.limit !== undefined &&
        (!Number.isSafeInteger(root.limit) || (root.limit as number) <= 0)
      ) {
        throw new BridgeRequestError(
          "request.limit must be a positive safe integer"
        );
      }
      return {
        schema: STATE_RUNTIME_BRIDGE_REQUEST_SCHEMA,
        operation: "history",
        ...(root.limit === undefined ? {} : { limit: root.limit as number })
      };
    }
    case "verify":
      exactKeys(root, ["schema", "operation"], [], "request");
      return { schema: STATE_RUNTIME_BRIDGE_REQUEST_SCHEMA, operation: "verify" };
    default:
      throw new BridgeRequestError(
        `unsupported State Runtime bridge operation ${root.operation}`
      );
  }
};

const runEffect = async <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
  const result = await Effect.runPromise(Effect.either(effect));
  if (result._tag === "Left") {
    throw result.left;
  }
  return result.right;
};

const execute = async (
  store: StateRuntimeStore,
  request: StateRuntimeBridgeRequest
): Promise<StateRuntimeBridgeResponse> => {
  switch (request.operation) {
    case "put_record":
      return ok(request.operation, await runEffect(store.putRecord(request.record)));
    case "get_record":
      return ok(request.operation, await runEffect(store.getRecord(request.digest as never)));
    case "put_map":
      return ok(request.operation, await runEffect(store.putMap(request.map)));
    case "get_map":
      return ok(request.operation, await runEffect(store.getMap(request.digest as never)));
    case "current":
      return ok(request.operation, await runEffect(store.current));
    case "compare_and_swap_current":
      await runEffect(store.compareAndSwapCurrent(request.expected, request.next));
      return ok(request.operation, null);
    case "history":
      return ok(request.operation, await runEffect(store.history(request.limit)));
    case "verify":
      return ok(request.operation, await runEffect(store.verify));
  }
};

const ok = (
  operation: StateRuntimeBridgeRequest["operation"],
  value: Extract<StateRuntimeBridgeResponse, { readonly _tag: "Ok" }>["value"]
): StateRuntimeBridgeResponse => ({
  schema: STATE_RUNTIME_BRIDGE_RESPONSE_SCHEMA,
  _tag: "Ok",
  operation,
  value
});

const refused = (
  operation: string | null,
  cause: unknown
): StateRuntimeBridgeResponse => {
  if (cause instanceof BridgeRequestError) {
    return {
      schema: STATE_RUNTIME_BRIDGE_RESPONSE_SCHEMA,
      _tag: "Refused",
      operation,
      code: "invalid-request",
      detail: cause.message
    };
  }
  if (cause instanceof StateRuntimeConflict) {
    return {
      schema: STATE_RUNTIME_BRIDGE_RESPONSE_SCHEMA,
      _tag: "Refused",
      operation,
      code: "conflict",
      detail: cause.message,
      expectedGeneration: cause.expectedGeneration,
      observedGeneration: cause.observedGeneration
    };
  }
  if (cause instanceof StateRuntimeValidationError) {
    return {
      schema: STATE_RUNTIME_BRIDGE_RESPONSE_SCHEMA,
      _tag: "Refused",
      operation,
      code: "validation",
      detail: `${cause.path}: ${cause.message}`
    };
  }
  if (cause instanceof StateRuntimeCorrupt) {
    return {
      schema: STATE_RUNTIME_BRIDGE_RESPONSE_SCHEMA,
      _tag: "Refused",
      operation,
      code: "corrupt",
      detail: cause.message
    };
  }
  if (cause instanceof StateRuntimeReadError) {
    return {
      schema: STATE_RUNTIME_BRIDGE_RESPONSE_SCHEMA,
      _tag: "Refused",
      operation,
      code: "read",
      detail: cause.message
    };
  }
  if (cause instanceof StateRuntimeWriteError) {
    return {
      schema: STATE_RUNTIME_BRIDGE_RESPONSE_SCHEMA,
      _tag: "Refused",
      operation,
      code: "write",
      detail: cause.message
    };
  }
  return {
    schema: STATE_RUNTIME_BRIDGE_RESPONSE_SCHEMA,
    _tag: "Refused",
    operation,
    code: "internal",
    detail: cause instanceof Error ? cause.message : String(cause)
  };
};

const argument = (name: string): string => {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined || value.trim().length === 0) {
    throw new BridgeRequestError(`missing ${name}`);
  }
  return value;
};

const readStdin = async (): Promise<string> => {
  process.stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of process.stdin) {
    text += String(chunk);
  }
  return text;
};

const main = async (): Promise<void> => {
  let operation: string | null = null;
  let store: StateRuntimeStore | undefined;
  try {
    const projectId = argument("--project");
    const path = argument("--path");
    const input = JSON.parse(await readStdin()) as unknown;
    if (typeof input === "object" && input !== null && !Array.isArray(input)) {
      operation =
        typeof (input as Record<string, unknown>).operation === "string"
          ? String((input as Record<string, unknown>).operation)
          : null;
    }
    const request = parseRequest(input);
    operation = request.operation;
    store = await runEffect(openNodeSqliteStateStore({ projectId, path }));
    process.stdout.write(JSON.stringify(await execute(store, request)));
  } catch (cause) {
    process.stdout.write(JSON.stringify(refused(operation, cause)));
  } finally {
    if (store !== undefined) {
      try {
        await runEffect(store.close);
      } catch {
        // The response already captures the semantic operation result. Process
        // teardown is a mechanism detail and cannot retroactively rewrite it.
      }
    }
  }
};

await main();
