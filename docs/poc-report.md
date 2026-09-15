# Classic vs. NextGen: what we built and what moving forward costs

**Prepared by:** Disha Negi · **Repo:** bedrock-opensearch-replica · **Date:** September 1, 2026
**Published version (design/visuals):** https://claude.ai/code/artifact/170fb055-4c56-411b-a16a-79634ea4400d

A working replica of the production connector, tested live against both OpenSearch Serverless
generations — plus what AWS's docs say, why we're on Titan, and what a real move to NextGen
requires.

## TL;DR

- All 8 stacks deployed live; seeded 1,784 real findings into **both** collections and queried
  head-to-head.
- NextGen ran **2.5–3.4× slower per query** than Classic, measured warm. NextGen's actual win is
  cost (scale-to-zero) — Classic bills ~$175/mo just to exist, idle or not.
- Titan is our pragmatic default (cost, parity, zero new infra) — **not a proven-best model.**
  Independent evidence puts it behind Cohere and open-source alternatives on quality.
- If token-based embeddings are the actual goal: no Bedrock/Vertex model generates them, and AWS
  confirms Serverless can't run the pipeline to serve them either way. That's a vector-store
  decision, not a model swap — see `alternative-platforms-research.md`.

## 01 — What we built

An 8-stack CDK replica of the production Bedrock→OpenSearch connector, extended to evaluate
NextGen head-to-head — all 8 stacks deployed and verified live, not just synthesized:
`IamStack` (roles/logs), `NetworkStack` (private VPC, both AOSS generations), `VectorStoreStack`
(Classic collection), `DataStack` (S3+DynamoDB source data), `ComputeStack` (the on-demand
connector), `NextGenVectorStoreStack` (NextGen collection), `DashboardStack` (eval UI,
keyword+vector search on both), `BastionStack` (SSM access to the private dashboard).

The comparison is Classic vs NextGen — two infrastructure generations of the same product, same
dataset, same Titan model on both — not keyword vs. vector search (both collections do both).

Architecture map: see `architecture-diagram.md`.

## 02 — Test results

Seeded 1,784 real findings into both collections via the dashboard's own seed path (same
S3/DynamoDB round-trip as production), then ran 5 fixed queries through `/api/compare` — one
embedding, fired at both collections in both modes simultaneously. All 20 searches returned 5/5
hits.

| Query | Classic kw | Classic vec | NextGen kw | NextGen vec |
|---|---|---|---|---|
| S3 bucket public read access | 137 ms | 111 ms | 405 ms | 603 ms |
| RDS not encrypted at rest | 136 ms | 123 ms | 207 ms | 337 ms |
| IAM wildcard permissions | 128 ms | 106 ms | 262 ms | 253 ms |
| Unrestricted inbound SSH | 167 ms | 141 ms | 422 ms | 436 ms |
| Lambda plaintext secrets | 103 ms | 97 ms | 355 ms | 347 ms |
| **Average** | **134 ms** | **116 ms** | **330 ms** | **395 ms** |

**Key observation:** NextGen was slower on every query — ~2.5× keyword, ~3.4× vector, measured
warm (not a scale-to-zero cold start). Small sample (5 queries, one run, default collection-group
sizing) — a real signal, not a benchmark verdict. k-NN scores matched exactly between collections
(same vector, same data); only BM25 scores differed, which is expected and not meaningful on its
own since raw BM25 depends on each index's own corpus statistics.

**Also observed:** the very first comparison query, fired immediately after the seed job
completed, failed with a raw AOSS `internal_server_exception` (HTTP 507); a retry seconds later
succeeded cleanly and every query since was reliable — likely transient load right after a
~1,800-document bulk index. `/api/compare` uses `Promise.all` across all 6 underlying searches,
so any one flaky call fails the whole response rather than degrading gracefully.

## 03 — What AWS's own docs say: Classic vs NextGen

NextGen reached GA on **May 28, 2026** — a genuinely new architecture (compute decoupled from
storage), not a rebrand.

| Dimension | Classic | NextGen |
|---|---|---|
| Autoscaling | Minutes | Seconds — up to 20× faster |
| Idle compute | Minimum 2 OCU floor, always billed | Scales to zero after 10 min idle |
| Capacity mgmt | Per collection | Per collection group, shared OCU limits |
| VPC connectivity | Custom `VpcEndpoint` resource, per collection | Standard PrivateLink (`com.amazonaws.{region}.aoss-data`) |
| Vector engine control | `Engine` (hnsw/faiss) configurable | Not configurable — unsupported |
| Cost profile | ~$175–350/mo minimum, even idle | Up to 60% lower for bursty/idle workloads |

Two rows we'd already hit ourselves before reading the docs: our own code comments independently
discovered the different VPC endpoint type and the unsupported `Engine` property — AWS's
documentation confirms both exactly.

## 04 — Why we're still on Titan — and whether it's actually the best option

**Titan is our pragmatic default, not a proven-best embedding model** — different claims, and
we'd only ever argued the first one until this research pass.

**What justifies it:** production parity (mirrors `kg.ts`, the reference codebase, field-for-
field), and cost + zero new infrastructure (5× cheaper than Cohere, 7.5× cheaper than Gemini
Embedding, and already behind the same private VPC endpoint — Vertex AI or any external provider
would mean routing outside a VPC built with no NAT/IGW).

**What the evidence says about quality:** the most detailed independent benchmark found
(testing an older Titan generation, V1) scored it worst of 5 models compared; a separate RAG
evaluation found Cohere beat an even older Titan generation (G1) outright; Titan doesn't appear
on a curated 2026 top-tier leaderboard where Gemini Embedding does. Independent,
current-V2-specific benchmarks are genuinely sparse — that's a real gap, not a "V2 is fine"
conclusion. Full detail and sources in `embedding-model-research.md`.

**If token-based embeddings are the actual goal:** Titan, Cohere-on-Bedrock, and Vertex AI all
only return pooled single vectors — confirmed, none support this. Providers that do (Jina,
Mixedbread, open-source) aren't Bedrock/Vertex models, and AWS's own docs confirm OpenSearch
Serverless — Classic or NextGen — can't run the pipeline needed to serve them anyway. This is a
provider-and-vector-store decision, not a config change.

## 05 — If we move forward with NextGen: what has to change

- **Infra:** NextGen needs a `CfnCollectionGroup` (already prototyped in
  `lib/nextgen-vector-store-stack.ts`), and rejects `StandbyReplicas: DISABLED` — Classic's
  current dev/test cost tier goes away under NextGen. VPC endpoint swap: drop the custom
  `VpcEndpoint` resource for a standard `ec2.InterfaceVpcEndpoint` — already built as
  `NetworkStack`'s `aossNextGenEndpointId`.
- **App code:** `app/src/opensearch.ts`'s `ensureIndex()` hardcodes
  `method: { name: "hnsw", engine: "faiss" }` — has to become conditional before it'll succeed
  against NextGen.
- **Confirmed (tested live):** the existing AOSS workarounds still apply, unchanged.
  `refresh: true` and `_delete_by_query` are both still rejected on NextGen, identically to
  Classic — `clearExistingEmbeddings()`'s workaround ports over as-is.
- **How the actual shift works:** AWS's documented tool is Amazon OpenSearch Ingestion (not the
  remote-reindex API, which is documented for domains, not collections). It's genuinely
  possible and documented for Serverless-to-Serverless migration — but this project doesn't
  need it, because OpenSearch holds nothing that isn't already in S3/DynamoDB. Every embedding
  is *derived* from that source data, so moving generations just means re-pointing the
  connector's env vars at the new collection and re-running — no data copy needed. The rebuild
  *is* the migration.

## 06 — The cost angle specifically

The connector is deliberately on-demand, not a standing service — close to a worst case for
Classic's pricing and a best case for NextGen's. Classic bills its OCU floor continuously
(~$175/mo, even our cheaper dev/test tier) whether the connector runs or not. NextGen scales to
zero after 10 min idle, so the realistic bill approaches the cost of actual runs, not a 24/7
floor. NextGen's win is workload-shaped: for an always-on, high-QPS service Classic can still be
the better fit — for an on-demand batch connector like ours, the numbers favor NextGen.

## 07 — Recommendation

Four separate decisions, not one go/no-go call — they don't all point the same way:

| If what you want is… | Then… | Because |
|---|---|---|
| **Lower cost** | Move to NextGen | Classic bills continuously regardless of use; NextGen scales to zero. Migration is cheap — no data copy, just re-point and re-run. |
| **Lowest latency** today | Stay on Classic | NextGen measured 2.5–3.4× slower, warm. Likely untuned default OCU capacity, not a hard ceiling — unproven until retested with a sized collection group. |
| **Best retrieval quality** | Neither this switch nor Titan gets you there | Collection generation doesn't touch embedding quality. Titan isn't evidenced as best-in-class — that's an embedding-model decision, separate from this one. |
| **Token-based embeddings** | Not a NextGen decision — a different architecture | Neither Serverless generation can run the required pipeline. Needs a different embedding provider (Jina/Mixedbread/self-hosted) *and* likely a different vector store (Vespa, or self-managed OpenSearch). |

## Sources

- [The next generation of Amazon OpenSearch Serverless is now generally available](https://aws.amazon.com/about-aws/whats-new/2026/05/amazon-opensearch-serverless-next-generation-generally-available/) — AWS, May 2026
- [Data plane access through AWS PrivateLink](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/serverless-vpc.html) — AWS Docs
- [Unsupported Machine Learning APIs and features](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/serverless-machine-learning-unsupported-features.html) — AWS Docs, confirms `ml_inference` unsupported on Serverless
- [Migrating Amazon OpenSearch Service indexes using remote reindex](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/remote-reindex.html) — AWS Docs
- [Migrating data between domains and collections using Amazon OpenSearch Ingestion](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/creating-opensearch-service-pipeline.html) — AWS Docs
- [Amazon Bedrock: How good (bad) is Titan Embeddings?](https://www.philschmid.de/amazon-titan-embeddings) — independent MTEB eval, tests Titan V1
- [RAG Evaluation: Titan vs Cohere](https://www.tonic.ai/blog/rag-evaluation-series-validating-the-rag-performance-of-amazon-titan-vs-cohere-using-amazon-bedrock) — Tonic.ai, tests Titan G1
- [MTEB Leaderboard 2026](https://www.codesota.com/benchmarks/mteb) — CodeSOTA, May 2026
- Repo code comments: `lib/vector-store-stack.ts`, `lib/nextgen-vector-store-stack.ts`, `app/src/opensearch.ts`
