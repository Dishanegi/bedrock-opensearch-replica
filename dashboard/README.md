# OpenSearch Pipeline Evaluation Hub

Side-by-side evaluation dashboard for comparing **Classic** vs **NextGen** Amazon OpenSearch Serverless collections — both running against the same seeded data, both queryable via **keyword (BM25)** and **vector (k-NN)** search. Retrieval-only: Amazon Titan (`amazon.titan-embed-text-v2:0`) is used for **embeddings**, not text generation — there is no LLM generation step in this component.

**Note on "Classic vs NextGen":** these terms refer to OpenSearch Serverless's two collection *generations* — an infrastructure/scaling distinction (see `lib/vector-store-stack.ts` vs `lib/nextgen-vector-store-stack.ts` in the parent project). They are **not** "keyword vs vector search" — both collections support both search modes here, which is exactly what this dashboard is built to compare (4 result panels: Classic-keyword, Classic-vector, NextGen-keyword, NextGen-vector).

## Executive summary

Given a query, the dashboard runs it against both OpenSearch collections in both keyword and vector mode simultaneously, and renders real, live results side by side — result titles, severities, relevance scores, per-query latency, hit counts, and (for vector search) the embedding model used. Nothing is mocked: every result comes from a real OpenSearch Serverless query against real seeded findings, and every embedding comes from a real Bedrock `InvokeModel` call.

## Architecture

```
Browser (inside the VPC / VPN-connected)
  → Internal ALB (no public IP, HTTP only)
    → ECS Fargate task (Express/Node — not Nginx; real API logic required)
      → Bedrock (embeddings)      via the bedrock-runtime Interface VPC endpoint
      → OpenSearch Serverless     via the AOSS VPC endpoint (Classic + NextGen collections)
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

There is **no file upload feature** — "Seed Sample Data" is a button that calls `POST /api/seed`, which generates ~40 finance/security-relevant findings server-side and embeds+indexes them directly into both collections. If a CSV/JSON upload path is wanted in the future, that would be new scope, not something to document as already existing.

## API

| Endpoint | Method | Body | Response |
|---|---|---|---|
| `/api/health` | GET | — | `{ status: "ok" }` — ALB target group health check |
| `/api/seed` | POST | — | `{ findingCount, indexedClassic, indexedNextGen }` |
| `/api/compare` | POST | `{ "query": string }` | `{ classic: { keyword, vector }, nextGen: { keyword, vector } }`, each an object of `{ mode, results[], latencyMs, hitCount, modelId }` |

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
| → S3 / DynamoDB | **Not used by this component** | Both exist elsewhere in the parent project as **Gateway** endpoints (not Interface/PrivateLink — AWS does not offer an Interface endpoint type for either service) |
| IAM | Reuses `IamStack`'s existing task/execution roles | `bedrock:InvokeModel` + `aoss:APIAccessAll`, both already scoped in `IamStack`; no new permissions added for this component |

## What this is not (yet)

- No TLS on the ALB — HTTP inside a private VPC only, by deliberate choice, not oversight.
- No RBAC/authentication in front of the dashboard itself — anyone who can reach the internal ALB (i.e., anyone inside the VPC or a connected network) can use it.
- No file upload — seeding is server-generated, not user-supplied data.
- No LLM generation step — this evaluates *retrieval*, not generated answers.
