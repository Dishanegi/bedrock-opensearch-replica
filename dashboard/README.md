# OpenSearch Pipeline Evaluation Hub

Side-by-side evaluation dashboard for comparing **Classic** vs **NextGen** Amazon OpenSearch Serverless collections — both running against the same seeded data, both queryable via **keyword (BM25)**, **vector (k-NN, Bedrock/Titan dense)**, **hybrid**, and **ASE (Automatic Semantic Enrichment, AOSS-managed sparse)** search. Titan (`amazon.titan-embed-text-v2:0`) is retrieval-only, used for embeddings not text generation, and ASE never calls Bedrock at all — there is no LLM generation step anywhere in this component.

**Note on "Classic vs NextGen":** these terms refer to OpenSearch Serverless's two collection *generations* — an infrastructure/scaling distinction (see `lib/vector-store-stack.ts` vs `lib/nextgen-vector-store-stack.ts` in the parent project). They are **not** a search-mode distinction — the dashboard is built to compare all four modes on both tiers (8 result panels: {Classic, NextGen} × {keyword, vector, hybrid, ASE}), but ASE support is **not** currently symmetric — see the next note. The other 3 modes on each tier: Classic-vector (Bedrock), NextGen-vector (Bedrock), plus keyword/hybrid on both.

**ASE support is per-collection, discovered live, and currently asymmetric.** Whether an AOSS collection can provision an ASE-enabled index was unconfirmed by AWS's own docs going in (see `../docs/comparison.md`'s ASE section) — this dashboard is the live test for it, via `CollectionClient.ensureAseIndex()`, which attempts provisioning on each tier the first time it's needed and caches whichever way it resolves, rather than assuming both collections behave the same. As of the most recent benchmark run (`dashboard/benchmark/`), the result was the *opposite* of what was originally worried about: **NextGen's ASE index provisions and returns real results; Classic's is denied** (see `dashboard/benchmark/run-benchmark.ts`'s comment) — despite `lib/vector-store-stack.ts`'s KMS/IAM grant being the identical shape as `lib/nextgen-vector-store-stack.ts`'s. Whichever tier is currently denied shows "Not available on this collection: \<reason\>" in its ASE panel instead of failing the whole comparison; `/api/seed/status` reports the same per-tier outcome right after seeding (see `ase` field below). Re-check both before trusting this description if the collections have been redeployed since.

## Executive summary

Given a query, the dashboard runs it against both OpenSearch collections in all four search modes simultaneously, and renders real, live results side by side — result titles, severities, relevance scores, per-query latency, hit counts, and (for vector/ASE) which model/mechanism produced them. Nothing is mocked: every result comes from a real OpenSearch Serverless query against real seeded findings, every dense embedding comes from a real Bedrock `InvokeModel` call, and every ASE result comes from AOSS's own service-managed sparse model — no Bedrock call at all for that mode.

## Architecture

```
Browser (inside the VPC / VPN-connected)
  → Internal ALB (no public IP, HTTP only)
    → ECS Fargate task (Express/Node — not Nginx; real API logic required)
      → Bedrock (embeddings)      via the bedrock-runtime Interface VPC endpoint
      → OpenSearch Serverless     via the AOSS VPC endpoint (Classic + NextGen collections)
      → AOSS control-plane API    via a third, separate Interface VPC endpoint
                                   (CreateIndex/GetIndex — ensureAseIndex()'s ASE provisioning)
```

No NAT gateway, no Internet Gateway, no public IP anywhere in this stack. This component does **not** call S3 or DynamoDB — those are used elsewhere in the parent project (the `ComputeStack` connector), not here.

## Prerequisites & local setup

- Node.js 20+, Docker (for the CDK asset build), AWS credentials with access to the parent project's account/region.
- The parent project's core stacks must already be deployed: `IamStack`, `NetworkStack`, `VectorStoreStack`, `DataStack`, `NextGenVectorStoreStack` (this dashboard reads their outputs — collection endpoints, VPC, IAM roles).

```bash
cd dashboard
npm install
npm run build      # tsc — compiles src/ to dist/
npx tsc --noEmit    # type-check only, no deploy
```

## Data loading

There is **no file upload feature** — "Seed Sample Data" is a button that calls `POST /api/seed`, which generates ~40 finance/security-relevant findings server-side, embeds+indexes them into both collections' dense (Bedrock/Titan) indexes, and separately writes the same findings' raw text into both collections' ASE indexes (`{indexName}-ase`) — AOSS generates the sparse embedding itself on that write, no Bedrock call involved. If a CSV/JSON upload path is wanted in the future, that would be new scope, not something to document as already existing.

## API

| Endpoint | Method | Body | Response |
|---|---|---|---|
| `/api/health` | GET | — | `{ status: "ok" }` — ALB target group health check |
| `/api/seed` | POST | — | `{ status: "started", total }` — fire-and-forget; poll `/api/seed/status` |
| `/api/seed/status` | GET | — | `{ status, phase, indexed, total, error?, ase?: { classic: { supported, reason? }, nextGen: { supported, reason? } } }` |
| `/api/compare` | POST | `{ "query": string }` | `{ classic: { keyword, vector, hybrid, ase }, nextGen: { keyword, vector, hybrid, ase } }`, each an object of `{ mode, results[], latencyMs, hitCount, modelId, error? }` — `error` is set only when that mode couldn't run at all (currently just ASE-on-an-unsupported-collection) |
| `/api/compare-ase` | POST | `{ "query": string }` | `{ classic, nextGen }`, each a single `SearchOutcome` — ASE only, isolated from the other three modes. Calls no Bedrock embedding at all (that's the point of ASE), so it's cheaper/faster than `/api/compare` when you only want to test ASE. Backs the dashboard's "Compare ASE Only" button. |

## Environment variables (set by `lib/dashboard-stack.ts`, not manually)

| Variable | Source | Purpose |
|---|---|---|
| `PORT` | `appConfig.dashboard.port` | Express listen port / ALB target port |
| `AWS_REGION` | `cdk.Aws.REGION` | SDK region for Bedrock + OpenSearch clients |
| `EMBEDDING_DIMENSION` | `appConfig.vectorStore.embeddingDimension` | Must match the Titan model's actual output dimension |
| `CLASSIC_OPENSEARCH_ENDPOINT` | `VectorStoreStack.collectionEndpoint` | Classic collection |
| `CLASSIC_INDEX_NAME` | `appConfig.vectorStore.indexName` | Classic collection's index |
| `NEXTGEN_OPENSEARCH_ENDPOINT` | `NextGenVectorStoreStack.collectionEndpoint` | NextGen collection |
| `NEXTGEN_INDEX_NAME` | `appConfig.dashboard.nextGenIndexName` | NextGen collection's index |

## Deployment (AWS ECS Fargate)

```bash
npx cdk deploy DashboardStack --require-approval never
```

`ecs.ContainerImage.fromAsset(dashboard/)` builds the Docker image locally (multi-stage: Node build stage → slim Node runtime, `CMD ["node", "dist/server.js"]`) and pushes it to a CDK-managed bootstrap ECR repository automatically — no manual `docker push` or ECR repo creation needed.

The stack output `DashboardUrl` gives the internal ALB's DNS name.

## Security & network topology

| Layer | Configuration | Notes |
|---|---|---|
| Compute | ECS Fargate, `PRIVATE_ISOLATED` subnets | No public IP assigned |
| Load balancer | Internal ALB (`internetFacing: false`), same private subnets | HTTP only — no TLS yet. The VPC boundary is the security control today; adding TLS needs a real domain + ACM cert (public or private CA), noted as a concrete follow-up, not implemented |
| ALB → Task | Security group, port matching `appConfig.dashboard.port`, source restricted to the ALB's security group only | No direct internet path to the task under any circumstance |
| Ingress to ALB | Security group, port 80, source restricted to the VPC's own CIDR block | Reachable only from inside the VPC or anything peered/VPNed into it — never the public internet |
| → Bedrock | `bedrock-runtime` **Interface** VPC endpoint | Pre-existing in `NetworkStack`, reused as-is |
| → OpenSearch (Classic + NextGen) | AOSS-specific `VpcEndpoint` resource (not a standard EC2 interface endpoint) | Pre-existing in `NetworkStack`, reused as-is; NextGen collection's network policy was extended to accept this same VPC endpoint alongside its existing public-access rule for laptop testing |
| → AOSS control-plane API | Standard **Interface** VPC endpoint, `com.amazonaws.<region>.aoss` (distinct service from the data-plane `.aoss-data` endpoint above) | Added to `NetworkStack` for ASE — `CollectionClient.ensureAseIndex()`'s `CreateIndex`/`GetIndex` calls go through this control-plane API, not the data-plane client. AZ-restricted (only `us-east-1b` selected — see the comment in `lib/network-stack.ts`), unlike every other endpoint here |
| → S3 / DynamoDB | **Not used by this component** | Both exist elsewhere in the parent project as **Gateway** endpoints (not Interface/PrivateLink — AWS does not offer an Interface endpoint type for either service) |
| IAM | Reuses `IamStack`'s existing task/execution roles | `bedrock:InvokeModel` + `aoss:APIAccessAll`, both already scoped in `IamStack`; also `aoss:CreateMLResource` (added for ASE — see `lib/iam-stack.ts`'s `AossSemanticEnrichment` statement), needed the first time `ensureAseIndex()` provisions an ASE-enabled index on a collection |

## What this is not (yet)

- No TLS on the ALB — HTTP inside a private VPC only, by deliberate choice, not oversight.
- No RBAC/authentication in front of the dashboard itself — anyone who can reach the internal ALB (i.e., anyone inside the VPC or a connected network) can use it.
- No file upload — seeding is server-generated, not user-supplied data.
- No LLM generation step — this evaluates *retrieval*, not generated answers.
