/**
 * The default `CommandRunner`.
 *
 * Deliberately tiny and injectable. Provisioning shells out to a container
 * runtime and to ssh; both are replaced in tests, which is the only way to
 * cover the dispatch and teardown paths without a daemon, an image, or a
 * network.
 */

import { ProvisionError, type CommandOptions, type CommandResult, type CommandRunner } from "./types.ts";

export const execCommand: CommandRunner = async (
  argv: string[],
  opts: CommandOptions = {},
): Promise<CommandResult> => {
  const bin = argv[0];
  if (bin === undefined) throw new ProvisionError("cannot run an empty command");

  let proc;
  try {
    proc = Bun.spawn(argv, {
      stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    // A missing binary throws rather than exiting non-zero. Callers probing for
    // an optional tool need to tell that apart from a tool that ran and failed.
    throw new ProvisionError(`${bin} could not be started: ${String(err)}`, "unknown", { cause: err });
  }

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};
