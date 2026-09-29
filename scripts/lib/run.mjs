// Cross-platform command runner: behaves the same on Windows (npm.cmd, npx.cmd shims) and Linux.
import { spawnSync } from "node:child_process";

const isWindows = process.platform === "win32";

/**
 * Runs a command synchronously and returns its result. On Windows the call goes through the shell
 * so that .cmd shims resolve. Only pass fixed arguments without spaces (the shell parses them);
 * never pass user input.
 * Pass `shell: false` for real executables (docker, git) so arguments are never re-parsed.
 * @param {string} command
 * @param {string[]} args
 * @param {{ capture?: boolean, cwd?: string, env?: NodeJS.ProcessEnv, shell?: boolean }} [opts]
 */
export function run(command, args, { capture = false, cwd, env, shell = isWindows } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: env ?? process.env,
    shell,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
