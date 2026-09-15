# docs/

Research, test results, and architecture proposals produced during the Classic-vs-NextGen
OpenSearch Serverless POC (September 2026). Saved here so the findings survive independently
of the live infrastructure (which was deployed for testing, then torn down) and independently
of the published artifacts (which can be updated/lost track of over time).

- **[poc-report.html](poc-report.html)** — the designed version (open in a browser): live test
  results (Classic vs NextGen, real latency numbers), what AWS's docs say about the two
  generations, whether Titan is actually the best embedding model (it isn't — evidenced), and a
  decision-framed recommendation. [poc-report.md](poc-report.md) is the same content as plain
  markdown, for reading in an editor/terminal.
- **[architecture-diagram.html](architecture-diagram.html)** — the designed version (open in a
  browser): the system map, how the 8 CDK stacks connect, the three real access paths, and the
  non-obvious things it surfaces (shared IAM role across very different lifetimes, asymmetric KMS
  usage, NextGen's leftover public access path). [architecture-diagram.md](architecture-diagram.md)
  has the same content as a mermaid diagram, for reading in an editor/terminal.
- **[embedding-model-research.md](embedding-model-research.md)** — the evidence behind "Titan
  isn't proven best": independent MTEB benchmarks, a full technical profile of Cohere Embed v4,
  the current best-available options (Voyage, Qwen3-Embedding, NV-Embed-v2), and a precise,
  empirically-tested answer on token-based (late-interaction) embedding support.
- **[alternative-platforms-research.md](alternative-platforms-research.md)** — what it would
  take to get off Bedrock entirely: integrated embedding+search platforms (Vespa, Qdrant,
  Weaviate, Pinecone), the AWS-native alternatives (SageMaker, and why Kendra/Q Business/
  AgentCore don't actually fit), and the practical tradeoffs of each.
- **[embedding-migration-plan.md](embedding-migration-plan.md)** — the concrete plan for
  swapping the embedding model in production without downtime and without touching existing
  embeddings (the dual-index / shadow-migration pattern), mapped onto this project's actual code.
- **[comparison.md](comparison.md)** — the AOSS-vs-Vertex-vs-Vespa feature bake-off, plus a deep
  dive on Automatic Semantic Enrichment (ASE): what it is, how it differs from the Titan V2 dense
  pipeline, where it fits/doesn't, and a phased plan for a full Bedrock-to-ASE migration. The
  dashboard's `ase` search mode and `lib/network-stack.ts`'s AOSS control-plane VPC endpoint are
  the live implementation of this plan's Phase 0-1 groundwork.
- **[sparse-vs-dense-benchmark-plan.md](sparse-vs-dense-benchmark-plan.md)** — the benchmark
  design for quantitatively comparing ASE (sparse) against Titan V2 (dense) retrieval quality;
  `dashboard/benchmark/` is the runnable implementation of this plan.

## Status as of this writing

All 8 AWS stacks from the POC have been torn down (`cdk destroy --all`) after testing completed.
Nothing here depends on that infrastructure being live — it's all either findings from
completed tests, or forward-looking proposals not yet implemented.
