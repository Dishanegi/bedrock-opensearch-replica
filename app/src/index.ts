import { readDynamoDbDocuments } from "./dynamodb-source";
import { buildEmbeddingText, generateEmbedding } from "./embed";
import { clearExistingEmbeddings, ensureIndex, indexDocument, knnSearch } from "./opensearch";
import { readS3Documents, type Finding } from "./s3-source";

/**
 * Entrypoint for the connector container. On-demand only (invoked via
 * `aws ecs run-task`, per the plan's "no scheduled trigger" scope).
 *
 * Data sources, in order: S3 (jobs/{assetSlug}/FINDINGS_SUMMARY.json) +
 * DynamoDB (harness-findings table, full table scan) — see
 * s3-source.ts / dynamodb-source.ts for the reference patterns each
 * mirrors. If both are empty (e.g. a fresh deploy with nothing seeded yet),
 * falls back to one hardcoded sample finding so the container is still
 * runnable with zero data setup, as a pure connectivity smoke test.
 *
 * Findings are grouped by jobId and, for each group, existing embeddings
 * for that jobId are cleared before new ones are written — mirrors kg.ts's
 * writeUseCaseKnowledgeGraph call order (clear, then embed, then index) so
 * re-running the connector against the same source data doesn't produce
 * duplicate vectors.
 */
/** Exported (not auto-run on import) so seed-and-ingest.ts can sequence seed.ts's main() before this. */
export async function main(): Promise<void> {
  console.log("[connector] ensuring index exists...");
  await ensureIndex();

  console.log("[connector] reading findings from S3 and DynamoDB...");
  const [s3Findings, ddbFindings] = await Promise.all([readS3Documents(), readDynamoDbDocuments()]);
  let findings: Finding[] = [...s3Findings, ...ddbFindings];

  if (findings.length === 0) {
    console.log("[connector] no findings found in S3 or DynamoDB — using the built-in sample as a connectivity smoke test");
    findings = [
      {
        findingId: "sample",
        title: process.env.TEXT ?? "SQL injection in the login endpoint via unescaped input",
        severity: "high",
        assetName: "sample-asset",
        jobId: "sample-job",
        cwe: "CWE-89"
      }
    ];
  } else {
    console.log(`[connector] found ${s3Findings.length} finding(s) in S3, ${ddbFindings.length} in DynamoDB`);
  }

  const byJobId = new Map<string, Finding[]>();
  for (const finding of findings) {
    const group = byJobId.get(finding.jobId) ?? [];
    group.push(finding);
    byJobId.set(finding.jobId, group);
  }

  let lastEmbedding: number[] | undefined;
  for (const [jobId, group] of byJobId) {
    console.log(`[connector] clearing existing embeddings for jobId="${jobId}"...`);
    await clearExistingEmbeddings(jobId);

    for (const finding of group) {
      console.log(`[connector] embedding "${finding.findingId}" via Bedrock...`);
      const embedding = await generateEmbedding(buildEmbeddingText(finding));
      console.log(`[connector] got a ${embedding.length}-dimension vector for "${finding.findingId}"`);

      console.log(`[connector] indexing "${finding.findingId}" in OpenSearch...`);
      await indexDocument({ ...finding, embedding });
      lastEmbedding = embedding;
    }
  }

  if (lastEmbedding) {
    console.log("[connector] running a k-NN search against the last document indexed...");
    const results = await knnSearch(lastEmbedding, 5);
    console.log("[connector] nearest neighbors:", JSON.stringify(results, null, 2));
  }
}

// Only auto-run when this file is the process entrypoint (`node dist/index.js`
// / `npm start`) — not when imported by seed-and-ingest.ts.
if (require.main === module) {
  main().catch(err => {
    console.error("[connector] fatal error:", err);
    process.exit(1);
  });
}
