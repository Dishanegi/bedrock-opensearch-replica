| Feature | A — Improve AOSS | B — Google Vertex AI | C — Vespa AI |
|---|---|---|---|
| **Fixes 7 embedding call sites** | Yes — via shared lib or AOSS ingest pipelines. **Note: this is a code fix, doable today regardless of platform — not really an AOSS-specific benefit.** | No — all 7 remain + full auth rewrite | Yes — but requires switching embedding model |
| **Stays on AWS / existing auth** | Unchanged | No — GCP + Google OAuth rewrite | No — new mTLS/token auth across all call sites |
| **Scale to zero (burst workloads)** | **NextGen tier only** (GA 28 May 2026, ~3 months old) — 0 OCU min. **Classic tier has a 2-OCU floor (~$350/mo idle).** Confirm which tier you run. | No — always-on VMs (`minReplicaCount ≥ 1`) | No — always-on nodes; dev/perf zones downscale but don't suspend (14-day idle expiry only) |
| **Rich metadata filtering** | Full bool filter in k-NN (dates, paths, wildcards) — confirmed | Token + numeric only. **Date ranges actually work via epoch-timestamp numeric restricts — no native date type is the real gap, not "not supported."** No full-text search — confirmed | Full filter support via YQL — confirmed |
| **Freshness SLA after indexing** | **10s on NextGen only. Classic is documented at 60 seconds**, not 10. | "Short delay" — not published — confirmed | Real-time (sub-second, milliseconds) — confirmed |
| **Full document in search response** | Yes — confirmed. **NextGen excludes the vector field from `_source` by default** (set `"_source": true` to get it back) | No — IDs + distances only by default. **Escape hatch exists: `return_full_datapoint=true` returns full docs, at latency/payload cost** | Yes — confirmed, no caveats. All fields return by default via Vespa's "document summary" (the default summary includes every field); an optional custom summary class can trim the response to a subset, but that's opt-in, not the default. |
| **Hybrid search (semantic + keyword)** | Supported — added **7 Aug 2025** (verified exact date). BM25 + neural via normalization pipeline, min_max/L2, arithmetic/geometric/harmonic mean. **Exactly 11 named regions** (verified). Up to 15s latency on first query — verified verbatim in AWS docs. GA/preview genuinely unstated. | Supported via HybridQuery + RRF (`rrf_ranking_alpha`, 0.0–1.0, verified). No native sparse encoder — confirmed, Google's own docs say to compute it externally. | Fully native via YQL OR composition — confirmed. **Exception: `dotproduct`/MIPS metric is not normalized to [0,1] and needs a manual sigmoid** — the "natively normalized" claim doesn't hold for that metric. |
| **Data stays in your AWS account** | Yes | No — moves to GCP | Enclave/self-hosted only |
| **Data retention / TTL** | Lifecycle policies apply to time series only, not vector search — **confirmed verbatim in AWS docs**. External automation required. | No TTL. Manual deletion via `removeDatapoints()` only — confirmed | Native GC via timestamp + selection expression, best-effort — confirmed |
| **Re-embedding required on migration** | Yes. **Doc assumes Titan V2 — but Titan V2 outputs 256/512/1024 dims, not 1536. If the corpus is 1536-dim, it's actually Titan G1, a dated model. Resolve this before trusting the quality baseline.** | Yes — confirmed | Yes — confirmed, worse if switching to ONNX |
| **SPLADE (sparse token weights)** | Partial — service-managed model via Automatic Semantic Enrichment is genuinely black-box — confirmed. **But "can't bring your own SPLADE model" is overstated: a self-hosted SPLADE model works via a remote SageMaker connector**, just not hosted inside AOSS. | No native model — confirmed | Yes — native `splade-embedder` — confirmed |
| **ColBERT (per-token, late interaction)** | **"Not supported" is wrong for OpenSearch generally** — only true for Serverless specifically. Managed OpenSearch 3.3+ added `lateInteractionScore` + SageMaker-hosted ColBERT reranking. | No — confirmed | Yes — native `colbert-embedder`, MaxSim scoring. **32× compression via int8 is Vespa's real documented figure — but it's 1-bit binarization packed into an int8 container, not standard int8 quantization (which is 4×). Clarify this or ML-literate readers will misread it.** |
| **Long document chunking** | Yes — `text_chunking` ingest processor — confirmed | No native support — confirmed | Yes — per-chunk ColBERT tensors, real `max-document-tokens` param (default 256) — confirmed |
| **Search engine API surface** | Full Query DSL, Explain, PIT, multi-search — confirmed. **"Full... aggregations, SQL, PPL" overstated: the V2 SQL/PPL engine doesn't support `date_histogram`, `terms`, `stats`, `percentiles`, or joins.** | Proprietary matching API only — confirmed | YQL — rich, confirmed |

## Alternative to Titan V2: Automatic Semantic Enrichment (ASE)

AOSS has a second embedding path that isn't Bedrock/Titan at all — **Automatic Semantic Enrichment (ASE)**, launched Aug 2025. It's worth evaluating as a partial replacement for the current pipeline, with one hard limitation: **it is sparse-only, not a drop-in for what Titan V2 does today.**

**What it is:** A service-managed sparse embedding model built directly into OpenSearch Service. You enable it per text field; AOSS generates and stores the embedding itself — no external model call, no connector, no Bedrock dependency for that field.

**How it differs from Titan V2 (the key distinction):**

| | Titan V2 (current) | ASE |
|---|---|---|
| Vector type | Dense | Sparse (learned term expansion) |
| Who generates it | Bedrock, via connector — app code calls it | AOSS itself, internally — no external call |
| Query-time cost | Calls Bedrock again to embed the query | None — query is just tokenized, no model call |
| Captures | Conceptual/paraphrase similarity | Term overlap, expanded with learned related terms |
| Configurable? | Yes — model choice, dimensions | No — fixed, black-box model |

**Because ASE only produces sparse vectors, it does not remove the need for Bedrock if dense/semantic k-NN search stays part of the architecture.** It's additive: a free sparse signal alongside the existing dense one, not a wholesale replacement. Fully dropping Bedrock would mean going sparse-only — a real quality trade-off, not a config change (see "where it doesn't fit" below).

**How it works mechanically:**
- **Ingest:** the model expands each document's text into a weighted set of related terms (not just the literal words), stored in native Lucene format.
- **Query:** your search text is only tokenized — never re-run through the model. This is why it adds zero search-time latency, but it also means the "understanding" is frozen at whatever the model learned during training, with no ability to adapt per-query.

**How to implement it:**
1. Confirm your collection is in a supported region (11 regions, incl. us-east-1, us-west-2, eu-west-1 — [full list](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/serverless-semantic-enrichment.html#serverless-semantic-enrichment-supported-regions)).
2. Add IAM + data access permissions for `aoss:CreateMLResource` (AOSS provisions the model/pipeline for you — no manual connector setup).
3. Enable it on a **test index first**, on a text field — e.g.:
   ```json
   "description": {
     "type": "text",
     "semantic_enrichment": { "status": "ENABLED", "language_options": "english" }
   }
   ```
4. Ingest a real sample of findings and run existing `match` queries against it — ASE auto-rewrites `match` queries into sparse queries, no query-code changes needed.
5. Compare results against current Titan V2 dense search on the same query set before deciding scope.

**Where it fits best:** natural-language, descriptive fields — finding summaries, remediation guidance, analyst notes — where a searcher's wording may not match the stored wording.

**Where it doesn't fit — and this maps directly onto security findings:**
- **Exact identifiers** (CVE IDs, CWE codes, function names, file paths, hostnames) — expansion adds noise here, not recall.
- **Logs, stack traces, config dumps** — AWS's own docs flag this as a poor fit: exact matching already suffices, and the added index size isn't worth it.
- **Long fields** — only the first 8,192 tokens (English) are processed; longer content needs chunking first.

**Recommendation:** don't treat this as an all-or-nothing swap for Titan. Pilot it on the descriptive/free-text fields only, keep exact-match and log-heavy fields on lexical or the existing dense pipeline, and measure against the same CVE/paraphrase test-query set used to validate Bedrock Rerank — since both changes are trying to close the same quality gap and should be evaluated together, not separately.

**Cost:** billed only at ingest, in Semantic Search OCUs — $0.24/OCU-hr, ~11.1M tokens per OCU-hour. No search-time or storage charge.

**Does ASE remove the Bedrock dependency? No.** ASE only produces sparse vectors. Dense/semantic k-NN search — what Titan V2 actually provides today — has no equivalent inside ASE. Bedrock (or SageMaker) stays required for any dense embedding, regardless of whether ASE is enabled.

**⚠️ Open question — NextGen compatibility unconfirmed.** AWS's ASE documentation never mentions "NextGen" or "Classic" — it only distinguishes by collection *type* (Search/Time Series/Vector), not compute tier. ASE launched Aug 2025; NextGen went GA May 2026, nine months later. Do not assume compatibility — confirm by testing `semantic_enrichment: ENABLED` on an actual NextGen collection (or via AWS Support) before this goes in front of management.

**Resolved, and the opposite of what was suspected here.** `lib/network-stack.ts`, `lib/iam-stack.ts`, `lib/vector-store-stack.ts`, and `lib/nextgen-vector-store-stack.ts` now provision the control-plane endpoint, IAM permissions, and a per-collection customer-managed KMS key (with an identical `aoss.amazonaws.com` + `es.amazonaws.com` grant) needed for ASE on *both* tiers — see `dashboard/src/opensearch.ts`'s `ensureAseIndex()`, which discovers support live per collection rather than assuming parity. The actual benchmark run (`dashboard/benchmark/`, results in `dashboard/benchmark/results/`) found **NextGen's ASE index provisions and returns real, scored results; Classic's is currently denied** — see the comment at the top of `dashboard/benchmark/run-benchmark.ts`. So the risk this section anticipated on NextGen never materialized; the actual gap showed up on Classic instead, despite Classic having the "already proven" dense pipeline.

**Source:** [Automatic semantic enrichment for Serverless](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/serverless-semantic-enrichment.html) (AWS documentation)

### Implementation plan — AOSS + Bedrock → AOSS + ASE only

If the goal is to fully eliminate Bedrock and rely on ASE end-to-end, this is the phased migration.

**Phase 0 — Pre-flight (blocking)**
1. Confirm which compute tier the collection is actually on (Classic or NextGen).
2. If NextGen: test `semantic_enrichment: ENABLED` on a throwaway NextGen collection first. If it fails to provision, ASE isn't available there yet and this plan is blocked until AWS ships support — see the open question above.
3. If Classic: confirmed to work — proceed.

**Phase 1 — New index schema (replaces the `knn_vector` field)**

Stop defining a dense vector field + ingest pipeline. Replace with `semantic_enrichment` on the text field directly. Create this as a **new index** — ASE requires index recreation, not an in-place mapping update.

```json
// OLD — dense vector field + separate embedding pipeline
"finding_description": { "type": "text" },
"finding_embedding": {
  "type": "knn_vector",
  "dimension": 1024,
  "method": { "name": "hnsw", "engine": "nmslib" }
}
```
```json
// NEW — ASE handles embedding, no separate vector field needed
"finding_description": {
  "type": "text",
  "semantic_enrichment": { "status": "ENABLED", "language_options": "english" }
}
```

**Phase 2 — Delete the Bedrock ingest pipeline**

Remove the existing `text_embedding` ingest processor + `ml-inference` connector wired to Bedrock/Titan:
```bash
DELETE _ingest/pipeline/<your-titan-embedding-pipeline-id>
```
ASE provisions its own internal pipeline automatically — nothing to create or manage.

**Phase 3 — Code changes at each of the 7 call sites**

For every call site, two things come out:
- **Write path:** delete the `bedrock-runtime:InvokeModel` call that generates the Titan vector before indexing — just index the raw text.
- **Read path:** delete the `bedrock-runtime:InvokeModel` call that embeds the query. Replace `knn`/`neural` query construction with a plain `match` query — ASE rewrites it internally:

```json
// OLD
{ "knn": { "finding_embedding": { "vector": [ /* Bedrock output */ ], "k": 10 } } }
// NEW
{ "match": { "finding_description": "auth bypass in login flow" } }
```

Once all 7 sites are converted, the Bedrock SDK dependency can be removed from the codebase entirely.

**Phase 4 — Re-ingest existing data**

ASE does **not** backfill existing documents. Scroll/paginate the old index and bulk-write every existing finding (raw text only) into the new ASE-enabled index — AOSS generates the embedding during this ingest. Verify row counts match old vs. new.

**Phase 5 — Parallel validation**

Run both indexes side by side against the CVE/paraphrase test-query set from the retrieval-quality bake-off. Diff top-10 results. Do not cut over until this is signed off — this is what catches a silent quality regression before it's user-facing.

**Phase 6 — Cutover**
1. Repoint application read/write traffic to the new index.
2. Keep the old (Bedrock-backed) index alive, read-only, as a rollback window.
3. Monitor the `SemanticSearchOCU` CloudWatch metric to confirm ingest billing looks sane.

**Phase 7 — Decommission Bedrock**
1. Delete the old index/collection.
2. Remove `bedrock:InvokeModel` (and related) IAM permissions from the app's role.
3. Remove any remaining ml-commons remote model/connector registrations pointing at Bedrock.
4. Remove the Bedrock SDK/dependency from the codebase if nothing else in the org uses it.

**Hard gate:** Phase 0's NextGen check must pass before scheduling any of Phases 1–7 — if it fails, the plan is blocked until AWS ships ASE support for that tier.