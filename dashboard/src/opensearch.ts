import { Client } from "@opensearch-project/opensearch";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws-v3";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
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
  mode: "vector" | "keyword" | "hybrid";
  results: SearchResult[];
  latencyMs: number;
  hitCount: number;
  modelId: string;
}

const SOURCE_FIELDS = ["findingId", "title", "severity", "assetName"];

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

  constructor(endpoint: string, indexName: string, supportsEngine: boolean) {
    this.indexName = indexName;
    this.supportsEngine = supportsEngine;
    this.client = new Client({
      ...AwsSigv4Signer({ region: REGION, service: "aoss", getCredentials: () => defaultProvider()() }),
      node: endpoint
    });
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

  private toOutcome(
    mode: "vector" | "keyword",
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
