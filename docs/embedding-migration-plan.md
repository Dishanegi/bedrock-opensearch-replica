# Embedding migration plan: getting off Titan safely

Manager's requirements, verbatim intent:
- [ ] Get out of Titan embeddings
- [ ] Current system should work as it is (enterprise-level architecture and logic)
- [ ] New integration shouldn't affect past embeddings

## The one fact everything else follows from

Embeddings from different models live in mathematically incompatible vector spaces. You cannot
convert a Titan vector into a Cohere vector (or any other model's vector) — there's no valid
transformation between them, even if the dimensions happen to match. Multiple independent
sources confirm this bluntly: *"every vector in your database must come from the same model with
the same settings; mixing models produces unreliable similarity scores."* This single fact is
why "swap the model" can't mean "update the existing index in place" — it has to mean "build a
new one alongside it." This is a well-known problem with an established name and pattern in the
industry: **dual-index / shadow migration**.

## How the pattern maps onto this project's three requirements

**☐ Get out of Titan embeddings**
→ Pick the new model (Cohere is the best-researched option already on Bedrock — zero new infra
since it's on the same private VPC endpoint; see `embedding-model-research.md` for the fuller
option set if leadership wants to go further). Write a new embed function for it — Cohere's
request/response shape differs from Titan's (`app/src/embed.ts` is currently Titan-specific), so
this is a new function, not a parameter tweak.

**☐ Current system should work as it is**
→ **The old index is never touched.** `ComputeStack`'s existing pipeline keeps reading/writing
the current Titan index exactly as today — same env vars, same behavior, zero changes, zero
downtime. The new model writes to a **brand-new index** (e.g. `replica-findings-kg-cohere`), not
a new field bolted onto the old one — OpenSearch's `knn_vector` field has a fixed dimension, so
two embedding spaces literally cannot share one field.

**☐ New integration shouldn't affect past embeddings**
→ Automatically true if the new index is genuinely separate. Nothing reads from or writes to the
old Titan vectors during migration — they sit there, unaffected, exactly as they were. This is
the whole point of the pattern: isolation, not modification.

## How the new index actually gets populated

Normal "backfilling" (re-embedding an existing corpus into a new model) is usually a real
engineering lift. Here, it's nearly free: this project's source of truth is S3/DynamoDB, not
OpenSearch (the same insight that makes the Classic→NextGen migration simple too — see
`poc-report.md` §05). Backfilling the new index is just **re-running the existing connector**,
pointed at the new model and new index name. No new pipeline to build, no data-copy tooling.

## Validation before cutover

Standard practice: run a golden set of queries against old and new side by side before trusting
the new model. `DashboardStack`'s compare mechanism, built for Classic-vs-NextGen, is
structurally the identical tool for Titan-vs-Cohere (or Titan-vs-whatever) — same queries, both
indices, side by side, already built.

## Cutover and rollback

**Cutover:** flip `ComputeStack`'s `OPENSEARCH_INDEX_NAME` + embedding model config to the new
index. A config change, not a rewrite.

**Rollback:** since the old index still exists untouched, rollback is just flipping the config
back. No data to restore.

**Decommission:** only after the new index has proven itself in production, delete the old
Titan index to reclaim storage. Not urgent, not part of the initial migration.

## Step-by-step summary

1. Choose the new embedding model (Cohere Embed v4 is the researched default; see
   `embedding-model-research.md` for the full option set).
2. Write a new embed function for it (new response-parsing logic, different shape than Titan's).
3. Create a new OpenSearch index with the correct `knn_vector` dimension for the new model
   (Cohere: 256/512/1024/1536 configurable).
4. Re-run the connector against the new model + new index — this re-embeds every finding from
   the original S3/DynamoDB source, with zero impact on the existing Titan index.
5. Validate: run the dashboard's compare mechanism (or an equivalent query set) against old vs.
   new, side by side.
6. Cut over: point production config at the new index/model.
7. Keep the old index around until confidence is high; decommission later, not urgently.

## Sources

- [Migrating vector embeddings in production without downtime — Google Cloud Community](https://medium.com/google-cloud/migrating-vector-embeddings-in-production-without-downtime-8a0464af6f55)
- [Migrate to a New Embedding Model — Qdrant](https://qdrant.tech/documentation/tutorials-operations/embedding-model-migration/)
- [Embedding Models in Production: Selection, Versioning, and the Index Drift Problem](https://tianpan.co/blog/2026-04-09-embedding-models-production-versioning-index-drift)
- [Embedding Portability and Versioning — Mixpeek](https://mixpeek.com/guides/embedding-portability-versioning)
- [Zero-Downtime Embedding Migration — DEV Community](https://dev.to/humzakt/zero-downtime-embedding-migration-switching-from-text-embedding-004-to-text-embedding-3-large-in-1292)
