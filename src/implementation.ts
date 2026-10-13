import { Effect } from "effect";

import { makeMemoryStateStore } from "./adapters/memory.js";
import type { StateRuntimeFailure, StateRuntimeStore } from "./store.js";

export const STATE_STORE_INTERFACE = "state/StateRuntimeStore/v1" as const;

export const STATE_STORE_CAPABILITIES = Object.freeze([
  "atomic-commit",
  "content-addressed-identity",
  "portable-snapshot",
  "strict-generation-cas",
  "verified-history",
] as const);

export const STATE_STORE_REQUIRED_CHECKS = Object.freeze([
  "atomic-commit",
  "cas-conflict",
  "history-verification",
  "snapshot-roundtrip",
] as const);

export interface StateImplementationBinding {
  readonly schema: "state.implementation-binding/v1";
  readonly projectId: string;
  readonly interface: typeof STATE_STORE_INTERFACE;
  readonly driver: string;
  readonly requiredCapabilities: readonly string[];
  readonly authority: "none";
}

/**
 * A realizable driver provided by a trusted consumer composition root.
 * Declaring capabilities does not prove them; each driver requires independent
 * State conformance, including crash/restart checks where applicable.
 */
export interface StateImplementationAdapter {
  readonly id: string;
  readonly version?: string;
  readonly requiredChecks?: readonly string[];
  readonly configurationSchemaDigest?: string | null;
  readonly capabilities: readonly string[];
  readonly open: (input: {
    readonly projectId: string;
    readonly configuration: unknown;
  }) => Effect.Effect<StateRuntimeStore, StateRuntimeFailure | StateImplementationRefused>;
}

export class StateImplementationRefused extends Error {
  override readonly name = "StateImplementationRefused";
  constructor(readonly reason:
    | "invalid-binding"
    | "duplicate-driver"
    | "missing-driver"
    | "missing-capability"
    | "invalid-configuration"
    | "store-identity-mismatch") {
    super("State implementation refused: " + reason);
  }
}

const valid = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isBinding = (value: unknown): value is StateImplementationBinding => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  if (
    Object.keys(obj).sort().join(",") !==
    "authority,driver,interface,projectId,requiredCapabilities,schema"
  ) return false;
  return obj.schema === "state.implementation-binding/v1" &&
    obj.authority === "none" &&
    obj.interface === STATE_STORE_INTERFACE &&
    valid(obj.projectId) && valid(obj.driver) &&
    Array.isArray(obj.requiredCapabilities) &&
    obj.requiredCapabilities.every(valid) &&
    new Set(obj.requiredCapabilities).size === obj.requiredCapabilities.length;
};

/**
 * Resolve a user-selected storage implementation without importing any Node
 * storage module into the State root or silently falling back to another DB.
 * Migrating an existing StateMap requires the separate verified snapshot path.
 */
export const openStateImplementation = (
  binding: StateImplementationBinding,
  adapters: readonly StateImplementationAdapter[],
  configuration: unknown
): Effect.Effect<StateRuntimeStore, StateRuntimeFailure | StateImplementationRefused> =>
  Effect.suspend(() => {
    if (!isBinding(binding)) {
      return Effect.fail(new StateImplementationRefused("invalid-binding"));
    }
    const ids = adapters.map((adapter) => adapter.id);
    if (ids.some((id) => !valid(id)) || new Set(ids).size !== ids.length) {
      return Effect.fail(new StateImplementationRefused("duplicate-driver"));
    }
    const adapter = adapters.find((candidate) => candidate.id === binding.driver);
    if (!adapter) return Effect.fail(new StateImplementationRefused("missing-driver"));
    const required = new Set([...STATE_STORE_CAPABILITIES, ...binding.requiredCapabilities]);
    if ([...required].some((capability) => !adapter.capabilities.includes(capability))) {
      return Effect.fail(new StateImplementationRefused("missing-capability"));
    }
    return Effect.flatMap(
      adapter.open({ projectId: binding.projectId, configuration }),
      (store) => {
        if (
          store.projectId !== binding.projectId ||
          store.mechanismId !== binding.driver
        ) {
          return Effect.flatMap(
            store.close,
            () => Effect.fail(new StateImplementationRefused("store-identity-mismatch"))
          );
        }
        return Effect.succeed(store);
      }
    );
  });

export const memoryStateImplementation: StateImplementationAdapter = {
  id: "memory",
  version: "1.0.0",
  requiredChecks: STATE_STORE_REQUIRED_CHECKS,
  configurationSchemaDigest: null,
  capabilities: STATE_STORE_CAPABILITIES,
  open: ({ projectId, configuration }) => {
    if (configuration !== null && configuration !== undefined) {
      return Effect.fail(new StateImplementationRefused("invalid-configuration"));
    }
    return makeMemoryStateStore(projectId);
  },
};
export interface StateExtensionContribution {
  readonly schema: "contract.extension-manifest/v1";
  readonly id: string;
  readonly version: string;
  readonly foundation: "state";
  readonly interface: { readonly id: "state/StateRuntimeStore"; readonly version: "v1" };
  readonly capabilities: readonly string[];
  readonly requiredChecks: readonly string[];
  readonly configurationSchemaDigest: string | null;
  readonly authority: "none";
}

export type StateImplementationDiscovery =
  | { readonly _tag: "StateImplementationDiscovery";
      readonly contributions: readonly StateExtensionContribution[];
      readonly authority: "none" }
  | { readonly _tag: "Refusal";
      readonly reason: "invalid-implementation-catalog" | "duplicate-implementation-identity" };

/**
 * Discover declared adapter capabilities without invoking open(). These are
 * catalog candidates, NOT conformance certificates and NOT permission to load
 * arbitrary third-party code. The host compiles these with Contract and runs
 * the required checks through its trusted Assurance verifier.
 */
export function describeStateImplementations(
  adapters: readonly StateImplementationAdapter[],
): StateImplementationDiscovery {
  if (!Array.isArray(adapters)) {
    return { _tag: "Refusal", reason: "invalid-implementation-catalog" };
  }
  const known = new Set<string>();
  const contributions: StateExtensionContribution[] = [];
  const semver = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;
  const validItem = (name: unknown): name is string =>
    typeof name === "string" && /^[a-z0-9][a-z0-9._:/-]*$/.test(name);
  for (const adapter of adapters) {
    if (!adapter || typeof adapter !== "object" ||
        !validItem(adapter.id) ||
        typeof adapter.version !== "string" || !semver.test(adapter.version) ||
        !Array.isArray(adapter.capabilities) || adapter.capabilities.length === 0 ||
        !adapter.capabilities.every(validItem) ||
        !STATE_STORE_CAPABILITIES.every((law) => adapter.capabilities.includes(law)) ||
        new Set(adapter.capabilities).size !== adapter.capabilities.length ||
        !Array.isArray(adapter.requiredChecks) || adapter.requiredChecks.length === 0 ||
        !adapter.requiredChecks.every(validItem) ||
        new Set(adapter.requiredChecks).size !== adapter.requiredChecks.length ||
        !STATE_STORE_REQUIRED_CHECKS.every((check) => adapter.requiredChecks?.includes(check)) ||
        (adapter.capabilities.includes("durable-restart") &&
          !adapter.requiredChecks.includes("crash-recovery")) ||
        (adapter.configurationSchemaDigest != null &&
          (typeof adapter.configurationSchemaDigest !== "string" ||
            !/^sha256:[0-9a-f]{64}$/.test(adapter.configurationSchemaDigest)))) {
      return { _tag: "Refusal", reason: "invalid-implementation-catalog" };
    }
    const key = adapter.id + "\\0" + adapter.version;
    if (known.has(key)) return { _tag: "Refusal", reason: "duplicate-implementation-identity" };
    known.add(key);
    contributions.push(Object.freeze({
      schema: "contract.extension-manifest/v1" as const,
      id: adapter.id,
      version: adapter.version,
      foundation: "state" as const,
      interface: Object.freeze({ id: "state/StateRuntimeStore" as const, version: "v1" as const }),
      capabilities: Object.freeze([...adapter.capabilities].sort()),
      requiredChecks: Object.freeze([...adapter.requiredChecks].sort()),
      configurationSchemaDigest: adapter.configurationSchemaDigest ?? null,
      authority: "none" as const,
    }));
  }
  contributions.sort((a, b) => [a.id,a.version].join(":").localeCompare([b.id,b.version].join(":")));
  return { _tag: "StateImplementationDiscovery", contributions: Object.freeze(contributions), authority: "none" };
}