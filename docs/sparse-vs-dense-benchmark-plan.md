# Benchmark plan: ASE (sparse) vs. Titan V2 (dense) vs. hybrid

**Status:** proposed, not yet run. No golden query set or measured numbers exist yet for
retrieval quality on this project's actual findings data — this plan is how to get them.

## Why this is needed

`comparison.md` and `poc-report.md` both make retrieval-quality claims (e.g. "Moderate — hybrid
+ sparse", "Titan isn't proven best") that are either untested assertions or benchmarked on
someone else's dataset (MTEB, BEIR), not this project's own findings corpus. Automatic Semantic
Enrichment (ASE, see `comparison.md`) raises the same question from a different angle: it's a
sparse model, structurally suited to exact-term matching (CVE IDs, CWE codes, function names)
but explicitly flagged by AWS as a weak fit for log-heavy content — which security findings are
full of. Whether that trade-off actually nets out well on *this* data is unverified either way.

This plan measures it directly instead of reasoning about it from vendor docs.

## What's being compared

1. **Dense (Titan V2, current)** — `knn`/`neural` query against a `knn_vector` field
2. **Sparse (ASE)** — `match` query against a `semantic_enrichment`-enabled text field (auto-rewritten internally, no query-time model call)
3. **Hybrid** — both combined via a `hybrid` query clause

## Step 1 — One index, both embedding types, same documents

Don't stand up two separate indexes — put both fields on the same finding documents so the
comparison is method-vs-method, not data-vs-data:

```json
"finding_text": {
  "type": "text",
  "semantic_enrichment": { "status": "ENABLED", "language_options": "english" }
},
"finding_embedding": {
  "type": "knn_vector",
  "dimension": 1024
}
```

## Step 2 — Build a labeled query set, split by category

Pull ~15–20 real queries per category below and hand-label which finding(s) should be the
correct result for each. The labeling step is what makes this a benchmark rather than a demo —
without a known-correct answer per query, results can only be eyeballed, not scored.

| Category | Example | Hypothesis |
|---|---|---|
| Exact identifier | A specific CVE ID, CWE code, or function name | Sparse wins |
| Paraphrase / conceptual | "auth bypass" vs. a finding worded "authentication check missing" | Dense wins |
| Log / stack-trace content | A snippet pulled from a real log or stack trace | Sparse or plain lexical wins |
| Mixed | A query combining an identifier and conceptual language | Hybrid wins |

~60–80 labeled queries total (15–20 × 4 categories) — a few hours of work to build, cheap to run
against data already on hand.

## Step 3 — Run every query three ways

- **Dense:** `knn`/`neural` query against `finding_embedding`
- **Sparse:** `match` query against `finding_text`
- **Hybrid:** `hybrid` query combining both

Record the **rank position** of the labeled-correct finding in each of the three result lists —
not just whether it appeared, but where.

## Step 4 — Score with standard IR metrics, per category

- **Recall@10** — did the correct finding land in the top 10 at all?
- **MRR (Mean Reciprocal Rank)** — average of 1/rank; penalizes a correct result that ranks low
  even if it technically appears
- **NDCG@10** — use if a query can have multiple valid results with different relevance levels,
  not a single exact answer

Score **per category, not as one blended average** — an overall number hides exactly the pattern
this benchmark exists to find (sparse winning on identifiers, dense winning on paraphrases).

## Step 5 — Read the results against the hypothesis

Specifically check:
- Does sparse actually beat dense on the exact-identifier and log-content categories, or does
  dense do fine there too?
- Does dense actually beat sparse on paraphrase queries, or did ASE's term-expansion catch more
  than expected?
- Does hybrid beat both individual methods on the mixed category — and does it ever perform
  *worse* than the better of the two alone? (Can happen if score normalization goes wrong —
  worth checking, not assuming hybrid is automatically safe.)

## Open dependencies before this can run

- **NextGen + ASE compatibility is unconfirmed** (see `comparison.md`) — if the test collection
  is NextGen, verify `semantic_enrichment: ENABLED` actually provisions before building the rest
  of this plan around it.
- **Possible `ml_inference` conflict** (see `poc-report.md` §04 and `comparison.md`'s corrections)
  — `poc-report.md` cites AWS docs stating `ml_inference` is unsupported on Serverless, which was
  used there to rule out token-based/late-interaction embeddings entirely. ASE's own ingest
  pipeline may or may not route through that same unsupported API — not yet verified either way.
  Confirm before assuming ASE is available at all on this project's actual collection.

## Sizing

~60–80 labeled queries, built once, run three times each (dense/sparse/hybrid) against data
already in S3/DynamoDB via this project's existing seed path. Sparse costs pennies at this
volume; dense reuses embeddings already being generated for the current pipeline.
