import { generateEmbedding } from "./embed";
import { knnSearch } from "./opensearch";

const K = Number(process.env.QUERY_K ?? "5");

/**
 * Ad hoc query entrypoint — not run by index.ts's main() or wired into
 * ComputeStack's default CMD. Invoke via an `aws ecs run-task` command
 * override (`["node", "dist/query.js"]`) with QUERY_TEXT set through
 * `--overrides`, since AOSS here is VPC-endpoint-only and unreachable
 * directly from a laptop. Embeds QUERY_TEXT via the same Bedrock call
 * index.ts uses, then runs a k-NN search and prints the results — read
 * them back from this task's CloudWatch Logs stream.
 */
async function main(): Promise<void> {
  const queryText = process.env.QUERY_TEXT;
  if (!queryText) {
    console.error("[query] QUERY_TEXT env var is required — set it via `aws ecs run-task --overrides`");
    process.exit(1);
  }

  console.log(`[query] embedding query text via Bedrock: "${queryText}"`);
  const embedding = await generateEmbedding(queryText);

  console.log(`[query] running k-NN search (k=${K})...`);
  const results = await knnSearch(embedding, K);
  console.log("[query] results:", JSON.stringify(results, null, 2));
}

main().catch(err => {
  console.error("[query] fatal error:", err);
  process.exit(1);
});
