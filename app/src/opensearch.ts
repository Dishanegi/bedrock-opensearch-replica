import { Client } from "@opensearch-project/opensearch";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws-v3";
import { defaultProvider } from "@aws-sdk/credential-provider-node";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const ENDPOINT = process.env.OPENSEARCH_ENDPOINT ?? "";
const INDEX_NAME = process.env.OPENSEARCH_INDEX_NAME ?? "replica-findings-kg";
// Set by ComputeStack from appConfig.vectorStore.embeddingDimension (lib/config.ts)
// — the single source of truth for this value now lives in CDK config, not
// duplicated as a separate hardcoded literal here.
const EMBEDDING_DIMENSION = Number(process.env.EMBEDDING_DIMENSION ?? "1024");

// Same fixed constant kg.ts uses for its JOB_TYPE field — this replica has
// no real job-orchestration layer, so every document is tagged the same way.
const JOB_TYPE = "replica-demo";

// Same page size kg.ts's clearExistingEmbeddings uses for its search_after loop.
const CLEAR_PAGE_SIZE = 1000;

// AwsSigv4Signer, not hand-rolled SigV4 — same client/auth approach as the
// reference codebase's containers/runner-core/src/kg.ts, service name
// "aoss" (not "es") since this targets OpenSearch Serverless.
const client = new Client({
  ...AwsSigv4Signer({
    region: REGION,
    service: "aoss",
    getCredentials: () => defaultProvider()()
  }),
  node: ENDPOINT
});

/**
 * Creates the index if absent, or recreates it if an existing index's
 * embedding field isn't knn_vector. Mirrors kg.ts's ensureOpenSearchIndex —
 * same self-healing check, same destructive delete-and-recreate on schema
 * mismatch (see opensearch-current-usage-technical.md §3.1 in the reference
 * research for why this is a known operational risk worth being aware of,
 * not a "safe by default" pattern to copy blindly into production).
 *
 * Field mapping matches kg.ts's ensureOpenSearchIndex exactly: findingId,
 * title, severity, assetName, jobId, jobType, cwe, createdAt, embedding.
 */
export async function ensureIndex(): Promise<void> {
  // Only a genuine 404 means "doesn't exist yet" — anything else (network
  // failure, auth failure, throttling) must not be silently reinterpreted
  // as "safe to create a new index," or a real outage could look like a
  // routine first-run. Matches the reference kg.ts's exact check:
  // `if ((e as {statusCode?: number}).statusCode !== 404) throw e;`
  let indexExists: boolean;
  try {
    const exists = await client.indices.exists({ index: INDEX_NAME });
    indexExists = !!exists.body;
  } catch (err) {
    const statusCode = (err as { meta?: { statusCode?: number } }).meta?.statusCode;
    if (statusCode !== 404) throw err;
    indexExists = false;
  }

  if (!indexExists) {
    await client.indices.create({
      index: INDEX_NAME,
      body: {
        settings: { index: { knn: true } },
        mappings: {
          properties: {
            embedding: {
              type: "knn_vector",
              dimension: EMBEDDING_DIMENSION,
              method: { name: "hnsw", engine: "faiss" }
            },
            findingId: { type: "keyword" },
            title: { type: "text" },
            severity: { type: "keyword" },
            assetName: { type: "keyword" },
            jobId: { type: "keyword" },
            jobType: { type: "keyword" },
            cwe: { type: "keyword" },
            createdAt: { type: "date" },
            classification: { type: "keyword" },
            summary: { type: "text" },
            remediation: { type: "text" },
            riskScore: { type: "integer" }
          }
        }
      }
    });
    return;
  }

  const mapping = await client.indices.getMapping({ index: INDEX_NAME });
  const embeddingType =
    mapping.body?.[INDEX_NAME]?.mappings?.properties?.embedding?.type ?? undefined;
  if (embeddingType !== "knn_vector") {
    await client.indices.delete({ index: INDEX_NAME });
    await ensureIndex();
  }
}

export interface FindingEmbeddingDoc {
  findingId: string;
  title: string;
  severity: string;
  assetName: string;
  jobId: string;
  cwe?: string;
  embedding: number[];
  createdAt?: string;
  classification?: string;
  summary?: string;
  remediation?: string;
  riskScore?: number;
}

/**
 * Indexes one finding's embedding. Same shape as kg.ts's per-document write
 * (kg.ts:990-1000): findingId/title/severity/assetName/jobId/cwe pass
 * through from the finding, jobType comes from the fixed JOB_TYPE constant,
 * and no client-supplied _id is set — AOSS Serverless doesn't support
 * client-supplied document IDs on index operations, so findingId is stored
 * only as a regular field in the body, not as the document's _id.
 */
export async function indexDocument(doc: FindingEmbeddingDoc): Promise<void> {
  await client.index({
    index: INDEX_NAME,
    body: {
      findingId: doc.findingId,
      title: doc.title,
      severity: doc.severity,
      assetName: doc.assetName,
      jobId: doc.jobId,
      cwe: doc.cwe ?? "",
      embedding: doc.embedding,
      jobType: JOB_TYPE,
      createdAt: doc.createdAt ?? new Date().toISOString(),
      classification: doc.classification ?? "",
      summary: doc.summary ?? "",
      remediation: doc.remediation ?? "",
      riskScore: doc.riskScore ?? 0
    }
    // No `refresh` option — AOSS Serverless only supports refresh=false
    // (the default); passing refresh: true fails with a 400
    // "true refresh policy is not supported" status_exception.
  });
}

/**
 * Deletes every existing doc for a given jobId before re-indexing it, so
 * re-running the connector against the same source data doesn't produce
 * duplicate vectors. Ports kg.ts's clearExistingEmbeddings (kg.ts:315-372)
 * verbatim in logic: AOSS Serverless has no `_delete_by_query`, so this
 * paginates via `search_after` (page size 1000) and bulk-deletes each
 * page's `_id`s, retrying each delete up to 4 attempts with the same
 * exponential-backoff-plus-jitter formula, skipping (non-fatal) a page that
 * still fails after retries rather than aborting the whole clear.
 */
export async function clearExistingEmbeddings(jobId: string): Promise<void> {
  let searchAfter: unknown[] | undefined;

  try {
    while (true) {
      const body: Record<string, unknown> = {
        query: { term: { jobId } },
        size: CLEAR_PAGE_SIZE,
        sort: [{ _id: "asc" }],
        _source: false
      };
      if (searchAfter !== undefined) body.search_after = searchAfter;

      const searchResp = await client.search({ index: INDEX_NAME, body });
      const hits = (searchResp.body.hits?.hits ?? []) as unknown as Array<{
        _id: string;
        sort?: unknown[];
      }>;
      if (hits.length === 0) break;

      const bulkBody = hits.flatMap(h => [{ delete: { _index: INDEX_NAME, _id: h._id } }]);
      let attempt = 0;
      while (true) {
        try {
          await client.bulk({ body: bulkBody });
          break;
        } catch (err) {
          const status = (err as { meta?: { statusCode?: number } }).meta?.statusCode;
          if ((status === 429 || status === 503 || status === 504) && attempt < 4) {
            const delay = Math.min(1000 * Math.pow(2, attempt), 15_000) + Math.random() * 500;
            await new Promise(r => setTimeout(r, delay));
            attempt++;
            continue;
          }
          console.error(
            `[opensearch] clearExistingEmbeddings: bulk delete failed for jobId=${jobId} after ${attempt} retries, skipping this page`,
            err
          );
          break; // non-fatal — skip this page and advance cursor
        }
      }

      if (hits.length < CLEAR_PAGE_SIZE) break; // last page
      searchAfter = hits[hits.length - 1].sort;
    }
  } catch (err) {
    console.error(`[opensearch] clearExistingEmbeddings: skipped for jobId=${jobId}`, err);
  }
}

export interface SimilarResult {
  findingId: string;
  title: string;
  severity: string;
  assetName: string;
  score: number;
}

/** k-NN similarity search — same query shape and _source fields as kg.ts's knn query. */
export async function knnSearch(embedding: number[], k = 5): Promise<SimilarResult[]> {
  const res = await client.search({
    index: INDEX_NAME,
    body: {
      size: k,
      query: { knn: { embedding: { vector: embedding, k } } },
      _source: ["findingId", "title", "severity", "assetName"]
    }
  });

  const hits = (res.body?.hits?.hits ?? []) as unknown as Array<{
    _score: number;
    _source: { findingId: string; title: string; severity: string; assetName: string };
  }>;
  return hits.map(h => ({ ...h._source, score: h._score }));
}
