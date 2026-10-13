import { Data } from "effect";

export class StateRuntimeValidationError extends Data.TaggedError("StateRuntimeValidationError")<{
  readonly path: string;
  readonly message: string;
}> {}

export class StateRuntimeWriteError extends Data.TaggedError("StateRuntimeWriteError")<{
  readonly mechanism: string;
  readonly message: string;
}> {}

export class StateRuntimeReadError extends Data.TaggedError("StateRuntimeReadError")<{
  readonly mechanism: string;
  readonly message: string;
}> {}

export class StateRuntimeCorrupt extends Data.TaggedError("StateRuntimeCorrupt")<{
  readonly message: string;
  readonly digest?: string;
}> {}

export class StateRuntimeConflict extends Data.TaggedError("StateRuntimeConflict")<{
  readonly expectedGeneration: number | null;
  readonly observedGeneration: number | null;
  readonly message: string;
}> {}
