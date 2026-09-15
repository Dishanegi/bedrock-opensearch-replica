# Embedding model research: is Titan actually the best option?

Short answer: no. Titan is the pragmatic default for this project (production parity + cost +
zero new infrastructure), not a proven-best embedding model. This doc has the evidence, a full
technical profile of the strongest alternative already on Bedrock (Cohere Embed v4), the current
best-available options industry-wide, and a precise, empirically-tested answer on whether any of
them support token-based embeddings.

## The evidence against "Titan is best"

- The most detailed independent MTEB evaluation found (Nov 2023, tests **Titan V1** — fixed
  1536-dim, an older generation than this project uses) scored it **66.01 — worst of 5 models
  compared**, against 74.35 for the best open-source model (bge-base-en-v1.5), while pricing it
  the same as OpenAI's premium Ada embeddings. Author's conclusion: *"I cannot recommend
  investing in building applications on Amazon Titan Embeddings."*
- A separate RAG evaluation (Tonic.ai, 55 question-answer pairs, tests **Titan G1** — an even
  older generation) found Cohere won on both average answer-similarity score and consistency:
  *"Cohere is the winner here, as a whole performing better than Amazon Titan."*
- **Independent, current-V2-specific benchmark data is genuinely sparse.** AWS's own material
  calls V2 "state-of-the-art," but no third-party MTEB or RAG evaluation isolating V2
  specifically (the way the V1/G1 studies above do) turned up. That's a real gap, not a settled
  "V2 is fine" conclusion.
- On a curated 2026 leaderboard of top-tier embedding models (15 models, MMTEB-style aggregate
  score), neither Titan nor Cohere appear at all — Google's `gemini-embedding-001` does, ranked
  #6 with a 67.7 retrieval score.
- A practitioner writeup using V2's actual pricing/dims (the most balanced, version-correct
  source found) recommends Titan V2 as a *"strong default for text-first RAG"* on internal
  technical documentation — explicitly on cost, flexibility, and operational-simplicity grounds,
  deliberately avoiding any numerical quality claim.

## Current MTEB retrieval rankings (best available, independent of provider)

| Model | Score | Access |
|---|---|---|
| Qwen3-Embedding-8B | 70.58 | Open-source (Apache 2.0), self-hosted |
| NV-Embed-v2 | 69.32 | Open-source, self-hosted |
| Gemini Embedding-001 | 67.71 | API-only, no self-hosting |
| Voyage-3-large / voyage-4 | ~67+ | API **or** self-hosted via AWS (SageMaker JumpStart / Marketplace) |
| Cohere embed-v4 | 65.2 | API (already on Bedrock) or VPC/on-prem |
| OpenAI text-embedding-3-large | 64.6 | API-only, no self-hosting |
| Titan V2 | not on this leaderboard | — |

**Two things worth knowing before picking one:**

1. **The actual top scorers are open-source, not a paid API.** Since this connector already runs
   its own compute (ECS Fargate), self-hosting Qwen3-Embedding-8B or NV-Embed-v2 inside the same
   account is architecturally realistic — no third-party API call, no VPC boundary to cross.
2. **Voyage AI is the strongest managed option, and it's deployable inside AWS.** Available via
   AWS Marketplace / SageMaker JumpStart — no VPC boundary to cross, unlike OpenAI or Gemini
   (API-only, no self-hosting — using either would mean punching a hole in a VPC built with no
   NAT/IGW).

## Cohere Embed v4 — full technical profile

The strongest alternative already on Bedrock (same private `bedrock-runtime` VPC endpoint this
project already calls — zero new infrastructure to adopt it).

- **Release:** April 15, 2025 — Cohere's 4th-generation embedding model.
- **Architecture:** unified multimodal — one call embeds text, images, or interleaved
  text+image content (including PDFs) into the same vector space.
- **Matryoshka embeddings:** nested representations at 256, 512, 1024, or 1536 dimensions — get
  the full 1536-dim vector but truncate to a smaller size with limited quality loss.
- **Vector output types:** float, int8, uint8, binary, ubinary — binary/ubinary can cut storage
  ~32× versus float, at some accuracy cost.
- **Context window:** 128K tokens (16× Titan V2's 8,192-token limit) — irrelevant for short
  findings like ours, genuinely useful for embedding whole long documents in one call.
- **Multilingual:** 100+ languages; Cohere claims a specific 15–20% quality improvement over
  prior versions on non-Latin scripts (Arabic, Hindi, Japanese, Chinese).
- **Pricing:** ~$0.12/1M text tokens ($0.00012/1K), $0.47/1M image tokens — roughly 5–6× Titan's
  cost, but at this project's data volume (1,784 short findings) that's cents, not dollars.
- **Quality:** 65.2 MTEB retrieval — mid-pack, but a real, evidenced improvement over Titan's
  unranked/below-baseline position.
- **API response shape:** `{"embeddings": {"float": [[...]]}}` — one pooled vector per input,
  just re-encoded in different numeric precisions via the `embedding_types` parameter. Different
  response shape than Titan, so swapping models means a small code change in `app/src/embed.ts`
  (new parsing logic), not an infra change.

**For this project specifically:** the multimodal, 128K-context, and non-Latin-language
strengths are all real capabilities Cohere has that Titan doesn't — but none apply to this
dataset (short, English-only, text-only security findings). The one number that does apply is
the MTEB retrieval score: 65.2 vs. Titan's unranked position.

## Token-based (late-interaction / ColBERT-style) embeddings — precise, tested answer

**Confirmed, not assumed: Titan, Cohere-on-Bedrock, and Vertex AI all only return pooled,
single-vector embeddings.** No parameter on any of them returns per-token vectors.

- Cohere's exact API response schema was checked directly: `output_dimension` picks the length
  of *one* vector; `embedding_types` picks its numeric precision. Neither adds more vectors.
  A direct search for any Cohere late-interaction/ColBERT/multi-vector product turned up nothing
  — no Cohere offering does this.
- Providers that *do* generate token-level embeddings: **Jina AI** (`jina-embeddings-v4`,
  `jina-colbert-v2`), **Mixedbread** (`Wholembed v3`), or open-source (**Sentence Transformers**
  v6's `MultiVectorEncoder`, loading PyLate/Stanford ColBERT/BGE-M3 checkpoints). None of these
  are Bedrock or Vertex AI models.
- **Even generating the vectors elsewhere doesn't make them usable on this project's
  infrastructure.** AWS's own ["Unsupported Machine Learning APIs and
  features"](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/serverless-machine-learning-unsupported-features.html)
  page explicitly rules out the standard mechanism (the `ml_inference` ingest/search pipeline)
  for OpenSearch Serverless — Classic **and** NextGen, no split by generation. That's the
  documented path every OpenSearch late-interaction tutorial assumes.
- **The one thing that does support token-based embeddings natively on OpenSearch is different
  and newer:** "Automatic Semantic Enrichment" — but it generates *sparse* vectors (a
  keyword-expansion technique), not the *dense* `knn_vector` embeddings this project's k-NN
  search is built on. Confirmed by direct empirical test against the live NextGen collection
  (`aws opensearchserverless create-index` with a `semantic_enrichment` field): the feature is
  real and processed on Serverless (not blocked the way general ML Inference pipelines are), but
  it still routes through an ML connector to a real backing model — my test IAM principal hit
  `AccessDeniedException: Access denied to create ML connector`, confirming there's no
  connector-free black box here. Sparse and dense are structurally incompatible field types —
  this feature couldn't populate a `knn_vector` field even with full permissions.

**Bottom line:** wanting token-based embeddings isn't a model swap on top of the current
architecture — it's a decision about the embedding provider *and* the vector store together
(see `alternative-platforms-research.md`).

## Sources

- [Best Embedding Models for RAG (2026), ranked by MTEB — PremAI](https://www.premai.io/blog/best-embedding-models-for-rag-2026-ranked-by-mteb-score-cost-and-self-hosting/)
- [Voyage AI 2026 — APIRank](https://apirank.vip/tutorials/voyage-ai-api-review/)
- [voyage-4 Embedding Model — AWS Marketplace](https://aws.amazon.com/marketplace/pp/prodview-oezpzvj5usjjk)
- [Amazon Bedrock: How good (bad) is Titan Embeddings? — philschmid.de](https://www.philschmid.de/amazon-titan-embeddings)
- [RAG Evaluation: Titan vs Cohere — Tonic.ai](https://www.tonic.ai/blog/rag-evaluation-series-validating-the-rag-performance-of-amazon-titan-vs-cohere-using-amazon-bedrock)
- [Agentic RAG with AWS 4: Embedding Model Selection — malinga.me](https://www.malinga.me/agentic-rag-embedding-model-selection/)
- [MTEB Leaderboard 2026 — CodeSOTA](https://www.codesota.com/benchmarks/mteb)
- [Announcing Embed Multimodal v4 — Cohere Changelog](https://docs.cohere.com/changelog/embed-multimodal-v4)
- [Cohere's Embed Models — Cohere Docs](https://docs.cohere.com/docs/cohere-embed)
- [Cohere Embed v4 pricing — pythonalchemist.com](https://www.pythonalchemist.com/embeddings/cohere-embed-v4)
- [Unsupported Machine Learning APIs and features — AWS Docs](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/serverless-machine-learning-unsupported-features.html)
- [Automatic semantic enrichment for Amazon OpenSearch Service — AWS Docs](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/opensearch-semantic-enrichment.html)
