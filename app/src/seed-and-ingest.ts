import { main as seed } from "./seed";
// DEFERRED: index.ts's ingest() calls Bedrock (embeddings) + OpenSearch
// (indexing) — commented out for now since we only want to verify S3/
// DynamoDB population at this stage, and VectorStoreStack/OpenSearch aren't
// reachable yet anyway. Uncomment this import and the call in main() below
// once ready to test the Bedrock/OpenSearch leg.
// import { main as ingest } from "./index";

/**
 * Runs seed.ts's main() — populates S3 + DynamoDB with dummy findings.
 * The ingest() step (index.ts's main(): read S3+DynamoDB, embed via Bedrock,
 * write to OpenSearch) is temporarily disabled — see the DEFERRED note above.
 * Once re-enabled, this runs both back-to-back in one process, so one
 * `ecs run-task` invocation covers seed + ingest instead of two separate
 * calls with different --overrides.
 */
async function main(): Promise<void> {
  console.log("[seed-and-ingest] step 1/2: seeding dummy findings into S3 + DynamoDB...");
  await seed();

  console.log("[seed-and-ingest] step 2/2 (ingest into OpenSearch): SKIPPED for now — see DEFERRED note at top of file.");
  // await ingest();
}

main().catch(err => {
  console.error("[seed-and-ingest] fatal error:", err);
  process.exit(1);
});
