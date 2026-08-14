export * from "./awake.ts";
export * from "./home-id.ts";
export * from "./daemon.ts";
export * from "./evolution/index.ts";
export * from "./federation/queued-intents.ts";
export * from "./hosts.ts";
export * from "./supervisor.ts";
export * from "./gateway/index.ts";
export * from "./provisioner/index.ts";
export * from "./routines/index.ts";
export * from "./voice/index.ts";

// The provisioner and the voice bridge each define a subprocess seam, and they
// picked the same two names for genuinely different shapes: the provisioner's
// `CommandRunner` is a function, the voice bridge's is an object with `which`
// and `run`. Two star exports of one name is ambiguous, so the plain names are
// bound explicitly to the provisioner's and the voice variants are re-exported
// under a prefix. Unifying them would couple two slices that have no reason to
// know about each other.
export type { CommandResult, CommandRunner } from "./provisioner/types.ts";
export type {
  CommandResult as VoiceCommandResult,
  CommandRunner as VoiceCommandRunner,
} from "./voice/exec.ts";
