// Gate: fails if any commit message in the checked range contains Hangul.
// Range: origin/master..HEAD when origin/master is available, otherwise HEAD only.
// CI must check out with fetch-depth: 0 so the range can be resolved.
// Usage: node scripts/check-commit-messages.mjs [<range>]
import { fileURLToPath } from "node:url";
import { HANGUL_RE } from "./lib/hangul-rules.mjs";
import { run } from "./lib/run.mjs";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));

const git = (args) => run("git", args, { shell: false, capture: true });

function resolveRange() {
  if (process.argv[2]) return process.argv[2];
  if (git(["rev-parse", "--verify", "--quiet", "origin/master"]).status === 0) return "origin/master..HEAD";
  return "HEAD^!";
}

const range = resolveRange();
const log = git(["log", "--format=%H%x00%B%x01", range]);
if (log.status !== 0) {
  console.error(`[check-commit-messages] git log ${range} failed\n` + log.stderr);
  process.exit(1);
}

const commits = log.stdout
  .split("\x01")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const [sha, body = ""] = s.split("\0");
    return { sha, body };
  });
const offenders = commits.filter((c) => HANGUL_RE.test(c.body));

if (offenders.length > 0) {
  console.error(`[check-commit-messages] Hangul found in ${offenders.length} commit message(s) in ${range} (English only):`);
  for (const c of offenders) console.error(`  ${c.sha.slice(0, 7)} ${c.body.split("\n")[0].slice(0, 100)}`);
  process.exit(1);
}

console.log(`[check-commit-messages] OK - ${commits.length} commit(s) in ${range}`);
