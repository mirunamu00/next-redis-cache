// Prints the comma-separated files of one mutation shard for `stryker run --mutate` (ROADMAP.md D59).
//
//   node scripts/mutation-shard.mjs 2/5          files of shard 2 of 5
//   node scripts/mutation-shard.mjs --plan 5     every shard with its weight (to check the balance)
import { fileURLToPath } from "node:url";
import stryker from "../stryker.config.mjs";
import { mutateTargets, parseShard, planShards } from "./lib/mutation-shards.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const targets = mutateTargets(root, stryker.mutate);
const args = process.argv.slice(2);

if (args[0] === "--plan") {
  const count = Number(args[1]);
  const shards = planShards(targets, count);
  const weight = Object.fromEntries(targets.map((t) => [t.file, t.weight]));
  shards.forEach((files, i) => {
    const total = files.reduce((n, f) => n + weight[f], 0);
    console.log(`${i + 1}/${count}  weight ${total}  ${files.join(",")}`);
  });
} else {
  const { index, count } = parseShard(args[0]);
  const files = planShards(targets, count)[index - 1];
  if (files.length === 0) {
    console.error(`[mutation-shard] shard ${index}/${count} has no files (more shards than files)`);
    process.exit(1);
  }
  console.log(files.join(","));
}
