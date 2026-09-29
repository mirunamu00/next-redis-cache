// Opens (or comments on) a GitHub issue when the nightly run fails (ROADMAP.md section 6.8).
// Runs in GitHub Actions only: needs GITHUB_TOKEN (issues: write), GITHUB_REPOSITORY, GITHUB_RUN_ID,
// GITHUB_SERVER_URL. One open issue with the label is reused, so repeated failures add comments.
//
//   node scripts/nightly-issue.mjs "<summary line>"
const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_SERVER_URL = "https://github.com" } = process.env;
const LABEL = "nightly-failure";
const summary = process.argv[2] ?? "nightly run failed";

if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) {
  console.error("[nightly-issue] GITHUB_TOKEN, GITHUB_REPOSITORY and GITHUB_RUN_ID are required");
  process.exit(1);
}

const api = async (method, path, body) => {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "nrc-nightly",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok && res.status !== 422) throw new Error(`${method} ${path}: HTTP ${res.status} ${await res.text()}`);
  return res.status === 204 ? undefined : res.json();
};

const runUrl = `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
const date = new Date().toISOString().slice(0, 10);
const text = `${date}: ${summary}\n\n${runUrl}`;

await api("POST", "/labels", { name: LABEL, color: "d73a4a", description: "Nightly workflow failed" }); // 422 if it exists
const open = await api("GET", `/issues?state=open&labels=${LABEL}&per_page=1`);
if (open.length > 0) {
  await api("POST", `/issues/${open[0].number}/comments`, { body: text });
  console.log(`[nightly-issue] commented on #${open[0].number}`);
} else {
  const issue = await api("POST", "/issues", { title: `Nightly failure (${date})`, body: text, labels: [LABEL] });
  console.log(`[nightly-issue] opened #${issue.number}`);
}
