import { Client } from "@opensearch-project/opensearch";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws-v3";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import {
  CreateIndexCommand,
  DeleteIndexCommand,
  GetIndexCommand,
  OpenSearchServerlessClient,
  ResourceNotFoundException
} from "@aws-sdk/client-opensearchserverless";
import { EMBEDDING_MODEL_ID } from "./embed";

const REGION = process.env.AWS_REGION ?? "us-east-1";

export interface Finding {
  findingId: string;
  title: string;
  severity: string;
  assetName: string;
  jobId?: string;
  cwe?: string;
  createdAt?: string;
  classification?: string;
  summary?: string;
  remediation?: string;
  riskScore?: number;
}

export interface SearchResult {
  findingId: string;
  title: string;
  severity: string;
  assetName: string;
  score: number;
  /** Only set on hybrid results — which underlying search actually surfaced
   *  this one. Deliberately NOT normalizing keyword (BM25) and vector
   *  (distance-based) scores onto one shared scale — they're not
   *  comparable, so showing each result's real, original score plus its
   *  source is more honest than inventing a fused number. */
  source?: "keyword" | "vector";
}

export interface SearchOutcome {
  mode: "vector" | "keyword" | "hybrid" | "ase";
  results: SearchResult[];
  latencyMs: number;
  hitCount: number;
  modelId: string;
  /** Set only when the mode couldn't run at all (e.g. ASE isn't enabled/
   *  supported on this collection) — the outcome still comes back with
   *  empty results instead of the whole /api/compare request failing. */
  error?: string;
}

const SOURCE_FIELDS = ["findingId", "title", "severity", "assetName"];

/** ASE's semantic_enrichment field option — English is the only language
 *  this project's seeded finding text is ever written in. */
const ASE_LANGUAGE = "english";

/**
 * One instance per OpenSearch Serverless collection (Classic, NextGen) — same
 * AwsSigv4Signer/service:"aoss" pattern as app/src/opensearch.ts, but wrapped
 * as a class so the dashboard can hold two independent instances side by side.
 */
export class CollectionClient {
  private readonly client: Client;
  private readonly indexName: string;
  /** NextGen collections don't support the Engine property on knn_vector
   *  fields (verified earlier this session) — Classic does and uses it. */
  private readonly supportsEngine: boolean;
  /** ASE requires its own index — semantic_enrichment can only be set when a
   *  text field is first created, not added to an existing mapping (see
   *  docs/comparison.md's ASE implementation plan, Phase 1) — so it can't
   *  share the dense knn_vector index above. */
  private readonly aseIndexName: string;
  /** Collection ID (not name/endpoint) — the opensearchserverless
   *  control-plane API's index operations are keyed by this, required for
   *  ASE provisioning specifically (see ensureAseIndex). */
  private readonly collectionId: string;
  /** Separate client for the opensearchserverless control-plane API
   *  (CreateIndex/GetIndex/DeleteIndex) — distinct from `client` above,
   *  which talks to the collection's own OpenSearch-compatible data-plane
   *  endpoint via SigV4. Confirmed against AWS's ASE docs: an ASE-enabled
   *  index must be created through this API, not a plain data-plane PUT —
   *  that mismatch was the actual cause of every earlier
   *  "unknown parameter [semantic_enrichment]" failure. */
  private readonly serverlessClient: OpenSearchServerlessClient;
  /** Undefined until ensureAseIndex() has actually been tried once. Whether
   *  NextGen collections support ASE at all is an open question (see
   *  docs/comparison.md) — this flag is how that gets discovered live,
   *  rather than assumed, and cached so every search after the first
   *  doesn't re-attempt a doomed index creation. */
  private aseSupported: boolean | undefined;
  private aseUnsupportedReason: string | undefined;

  constructor(endpoint: string, indexName: string, supportsEngine: boolean, collectionId: string) {
    this.indexName = indexName;
    this.supportsEngine = supportsEngine;
    this.aseIndexName = `${indexName}-ase`;
    this.collectionId = collectionId;
    this.client = new Client({
      ...AwsSigv4Signer({ region: REGION, service: "aoss", getCredentials: () => defaultProvider()() }),
      node: endpoint
    });
    this.serverlessClient = new OpenSearchServerlessClient({ region: REGION });
  }

  /** Mirrors app/src/opensearch.ts's ensureIndex() — self-healing create,
   *  with the Engine property conditional on this collection's generation. */
  async ensureIndex(embeddingDimension: number): Promise<void> {
    let indexExists: boolean;
    try {
      const exists = await this.client.indices.exists({ index: this.indexName });
      indexExists = !!exists.body;
    } catch (err) {
      const statusCode = (err as { meta?: { statusCode?: number } }).meta?.statusCode;
      if (statusCode !== 404) throw err;
      indexExists = false;
    }
    if (indexExists) return;

    const embeddingField: Record<string, unknown> = this.supportsEngine
      ? { type: "knn_vector", dimension: embeddingDimension, method: { name: "hnsw", engine: "faiss" } }
      : { type: "knn_vector", dimension: embeddingDimension };

    await this.client.indices.create({
      index: this.indexName,
      body: {
        settings: { index: { knn: true } },
        mappings: {
          properties: {
            embedding: embeddingField,
            findingId: { type: "keyword" },
            title: { type: "text" },
            severity: { type: "keyword" },
            assetName: { type: "keyword" },
            classification: { type: "keyword" },
            summary: { type: "text" },
            remediation: { type: "text" }
          }
        }
      }
    });
  }

  async indexDocument(finding: Finding, embedding: number[]): Promise<void> {
    await this.client.index({
      index: this.indexName,
      body: {
        findingId: finding.findingId,
        title: finding.title,
        severity: finding.severity,
        assetName: finding.assetName,
        classification: finding.classification ?? "",
        summary: finding.summary ?? "",
        remediation: finding.remediation ?? "",
        embedding
      }
      // No `refresh` option — AOSS Serverless only supports refresh=false.
    });
  }

  async deleteAll(): Promise<void> {
    try {
      await this.client.deleteByQuery({ index: this.indexName, body: { query: { match_all: {} } } });
    } catch {
      // Index may not exist yet on a fresh collection — non-fatal, ensureIndex creates it next.
    }
  }

  /** The ASE-enabled index schema, shared by create and (implicitly) get —
   *  matches AWS's own documented shape exactly: a plain-text field carrying
   *  `semantic_enrichment`, no `settings` block (ASE needs no `knn: true`,
   *  it isn't a vector-search mapping). */
  private aseIndexSchema() {
    return {
      mappings: {
        properties: {
          findingId: { type: "keyword" },
          title: { type: "text" },
          severity: { type: "keyword" },
          assetName: { type: "keyword" },
          classification: { type: "keyword" },
          remediation: { type: "text" },
          // AOSS generates and stores the sparse embedding itself on
          // ingest — no separate vector field, no Bedrock call. See
          // docs/comparison.md's "How it works mechanically".
          summary: {
            type: "text",
            semantic_enrichment: { status: "ENABLED", language_options: ASE_LANGUAGE }
          }
        }
      }
    };
  }

  /**
   * Creates the ASE-enabled index if absent, via the opensearchserverless
   * control-plane API's own CreateIndex/GetIndex operations — NOT the
   * generic OpenSearch data-plane client used everywhere else in this class.
   * This distinction is load-bearing: AWS's ASE documentation shows every
   * example going through `aws opensearchserverless create-index`, and a
   * plain data-plane PUT (what this method used to do) gets rejected with
   * "unknown parameter [semantic_enrichment]" — the raw OpenSearch mapper
   * genuinely doesn't know this field; only the control-plane API does.
   *
   * A failure here is read as "ASE isn't supported/enabled on this
   * collection" rather than a fatal error — cached in aseSupported so
   * callers (indexAseDocument, aseSearch) can no-op instead of retrying a
   * doomed call every time.
   */
  async ensureAseIndex(): Promise<{ supported: boolean; reason?: string }> {
    if (this.aseSupported !== undefined) {
      return { supported: this.aseSupported, reason: this.aseUnsupportedReason };
    }
    try {
      let exists = true;
      try {
        await this.serverlessClient.send(new GetIndexCommand({ id: this.collectionId, indexName: this.aseIndexName }));
      } catch (err) {
        if (err instanceof ResourceNotFoundException) {
          exists = false;
        } else {
          throw err;
        }
      }

      if (!exists) {
        await this.serverlessClient.send(
          new CreateIndexCommand({
            id: this.collectionId,
            indexName: this.aseIndexName,
            indexSchema: this.aseIndexSchema()
          })
        );
      }
      this.aseSupported = true;
      this.aseUnsupportedReason = undefined;
    } catch (err) {
      this.aseSupported = false;
      this.aseUnsupportedReason = (err as Error).message ?? "ASE index creation failed";
      console.error(`[opensearch] ASE not available on ${this.aseIndexName}:`, err);
    }
    return { supported: this.aseSupported, reason: this.aseUnsupportedReason };
  }

  /** No-ops (rather than throws) once ensureAseIndex has determined ASE
   *  isn't supported here — keeps seed.ts's per-finding loop from needing
   *  its own supported-check on every call. */
  async indexAseDocument(finding: Finding): Promise<void> {
    if (this.aseSupported !== true) return;
    await this.client.index({
      index: this.aseIndexName,
      body: {
        findingId: finding.findingId,
        title: finding.title,
        severity: finding.severity,
        assetName: finding.assetName,
        classification: finding.classification ?? "",
        remediation: finding.remediation ?? "",
        summary: finding.summary ?? ""
      }
    });
  }

  async deleteAllAse(): Promise<void> {
    if (this.aseSupported !== true) return;
    try {
      await this.client.deleteByQuery({ index: this.aseIndexName, body: { query: { match_all: {} } } });
    } catch {
      // Index may not exist yet — non-fatal, ensureAseIndex creates it next.
    }
  }

  async knnSearch(embedding: number[], k = 5): Promise<SearchOutcome> {
    const start = Date.now();
    const res = await this.client.search({
      index: this.indexName,
      body: { size: k, query: { knn: { embedding: { vector: embedding, k } } }, _source: SOURCE_FIELDS }
    });
    return this.toOutcome("vector", res, Date.now() - start, EMBEDDING_MODEL_ID);
  }

  async bm25Search(queryText: string, k = 5): Promise<SearchOutcome> {
    const start = Date.now();
    const res = await this.client.search({
      index: this.indexName,
      body: {
        size: k,
        query: { multi_match: { query: queryText, fields: ["title", "summary", "remediation"] } },
        _source: SOURCE_FIELDS
      }
    });
    return this.toOutcome("keyword", res, Date.now() - start, "N/A (lexical/BM25)");
  }

  /**
   * A plain `match` query — ASE rewrites it into a sparse query internally,
   * server-side, so there's no query-time model call of any kind (not even
   * to AOSS's own model — just tokenization). See docs/comparison.md's
   * "How it works mechanically". Returns a graceful "unsupported" outcome
   * instead of throwing when ensureAseIndex found ASE isn't available here.
   */
  async aseSearch(queryText: string, k = 5): Promise<SearchOutcome> {
    const { supported, reason } = await this.ensureAseIndex();
    if (!supported) {
      return {
        mode: "ase",
        results: [],
        latencyMs: 0,
        hitCount: 0,
        modelId: "N/A (ASE unsupported on this collection)",
        error: reason
      };
    }

    const start = Date.now();
    const res = await this.client.search({
      index: this.aseIndexName,
      body: { size: k, query: { match: { summary: queryText } }, _source: SOURCE_FIELDS }
    });
    return this.toOutcome("ase", res, Date.now() - start, "AOSS Automatic Semantic Enrichment (sparse, service-managed)");
  }

  private toOutcome(
    mode: "vector" | "keyword" | "ase",
    res: { body?: { hits?: { hits?: unknown } } },
    latencyMs: number,
    modelId: string
  ): SearchOutcome {
    const hits = (res.body?.hits?.hits ?? []) as unknown as Array<{ _score: number; _source: SearchResult }>;
    return { mode, results: hits.map(h => ({ ...h._source, score: h._score })), latencyMs, hitCount: hits.length, modelId };
  }

  /**
   * Semantic-primary hybrid search: vector (k-NN) results define the base
   * ranking (kept in their own order) — prioritizes recall, so a query
   * using different words than the documents still surfaces everything
   * conceptually relevant first. Keyword (BM25) search then fills in any
   * findings vector missed ENTIRELY, appended after the vector results
   * rather than interleaved — so a viewer can see exactly which results
   * semantic search found on its own vs which ones only exact-term
   * matching caught. Trades away some precision on near-duplicate pairs
   * (e.g. "read" vs "write" access — see the earlier finding this session
   * that vector search blurs these together) in exchange for not missing
   * conceptually-relevant results that don't share vocabulary with the
   * query. This is NOT score-fusion (e.g. reciprocal rank fusion) — BM25
   * and vector-distance scores aren't on a comparable scale, so each
   * result keeps its own real score and a `source` tag instead of a
   * fabricated blended number.
   */
  async hybridSearch(queryText: string, embedding: number[], k = 5): Promise<SearchOutcome> {
    const start = Date.now();
    const candidatePoolSize = Math.max(k * 4, 20);

    const [keywordOutcome, vectorOutcome] = await Promise.all([
      this.bm25Search(queryText, candidatePoolSize),
      this.knnSearch(embedding, candidatePoolSize)
    ]);

    const merged: SearchResult[] = [];
    const seen = new Set<string>();

    for (const r of vectorOutcome.results) {
      if (seen.has(r.findingId)) continue;
      merged.push({ ...r, source: "vector" });
      seen.add(r.findingId);
    }
    for (const r of keywordOutcome.results) {
      if (seen.has(r.findingId)) continue;
      merged.push({ ...r, source: "keyword" });
      seen.add(r.findingId);
    }

    const results = merged.slice(0, k);
    return {
      mode: "hybrid",
      results,
      latencyMs: Date.now() - start,
      hitCount: results.length,
      modelId: `${EMBEDDING_MODEL_ID} (primary) + BM25 (supplement)`
    };
  }
}
