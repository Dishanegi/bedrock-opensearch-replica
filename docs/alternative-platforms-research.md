# Getting off Bedrock entirely: platform research

Prompted by a manager requirement: get off Titan embeddings, keep the current system working as
is, and don't let a new integration affect past embeddings — with a follow-up clarifying the goal
might be broader: not using Bedrock at all, and wanting one system that does embedding *and*
search together, rather than the current two-step Bedrock (embed) + OpenSearch (search)
pipeline.

## Integrated embedding + search platforms (not AWS-native)

**Vespa — the strongest fit, and it answers two open questions at once.**
Vespa can load an embedding model (exported to ONNX format from Hugging Face) directly *inside
the search cluster itself*. Embedding generation and search happen in the same system, on the
same machine — no external API call to Bedrock, OpenAI, or anyone, at index time or query time.
This is genuinely different from OpenSearch's "automatic semantic enrichment" (which still calls
out to a connector-backed model) — Vespa runs the model in-process. Vespa is also the only
platform researched with mature, **native** ColBERT/token-based embedding support — a built-in
ColBERT embedder, tensor-native storage (no per-token row explosion), native MaxSim ranking
expressions, and a standard approximate-NN-retrieval-then-MaxSim-rerank pipeline. Picking Vespa
would answer "get off Bedrock" and "we want token-based embeddings" with one architecture
decision, not two.

**Qdrant — a lighter-weight alternative with the same shape.**
Has FastEmbed (local embedding generation, no external call) plus native sparse and ColBERT
multi-vector support. Smaller operational footprint than Vespa, similar independence from any
managed embedding API.

**Weaviate — integrated, but not fully Bedrock-free by default.**
Has a configurable "vectorizer" module — can point it at OpenAI, Cohere, Voyage, *or* a
self-hosted HuggingFace model. Can avoid Bedrock, but only if you specifically pick the
self-hosted module — the default pattern still assumes an external provider.

**Pinecone — integrated, but not something you self-host.**
Hosts embedding models directly inside its own managed inference layer — no separate embedding
API call from your app. But Pinecone is an external SaaS vector database; adopting it means
moving data and traffic to a third-party cloud service, not something deployable inside this
project's own AWS account/VPC.

**Practical read for this project's architecture:** Vespa and Qdrant can both be **self-hosted
inside the same AWS account** — deployed as a container on the same ECS infrastructure this
project already uses, inside the same private VPC, with the embedding model bundled in. That's
actually a *tighter* self-contained architecture than today's setup, which depends on an
external AWS service (Bedrock) for every embedding call.

## AWS-native alternatives

**Amazon Bedrock AgentCore is not actually "other than Bedrock."**
Officially part of the Bedrock family — it replaced the old "Bedrock Agents" (now in maintenance
mode as of July 2026). It's an agent *orchestration/runtime* platform (build/deploy/run AI
agents, framework-agnostic — LangGraph, CrewAI, Strands, etc.), not an embedding or search
service. Doesn't solve "get off Bedrock" even though the name sounds separate — it still carries
the Bedrock name because it is Bedrock.

**Amazon Kendra — researched, then found to be a dead end for new adoption.**
Initially looked like the closest AWS-native answer (fully separate service, built-in ML
relevance ranking, no manual embedding pipeline to own). **Correction after deeper research:
Kendra closed to new customers on July 30, 2026.** It's in maintenance mode — existing customers
keep running with bug fixes and security patches, but nobody can start using it fresh, and no
new features are being built. Since this project has never used Kendra, it cannot adopt it now.

**Amazon Q Business — same fate, one day later.**
Closed to new customers on July 31, 2026, as part of the same consolidation (~20 services moved
to maintenance mode). Existing applications keep running; new ones cannot start.

**The pointed part: AWS's own recommended replacement for both Kendra and Q Business is Amazon
Bedrock Knowledge Bases** — i.e., Bedrock. AWS is actively steering new projects *back into*
Bedrock, not away from it. If "not Bedrock" is a hard requirement, this is a real signal worth
surfacing to leadership — AWS doesn't currently offer a good non-Bedrock *packaged* embedding+
search product for new projects.

**Amazon SageMaker — the one clean AWS-native, genuinely non-Bedrock path that remains.**
Fully separate from Bedrock. Deploy *any* model — the open-source options above
(Qwen3-Embedding-8B, NV-Embed-v2) or Voyage AI's models — self-hosted, inside this AWS account,
zero calls to Bedrock's API. This is the AWS-native version of the "self-hosted, no external
embedding API" pattern Vespa/Qdrant offer, staying inside AWS's own managed infrastructure
instead of running a self-managed container.

## Summary decision table

| Option | Off Bedrock? | Self-hostable in this AWS account? | Token-based embeddings? | Notes |
|---|---|---|---|---|
| Vespa | Yes | Yes (own container) | Yes, native | Strongest single answer to both open questions |
| Qdrant | Yes | Yes (own container) | Yes, native | Lighter-weight than Vespa |
| Weaviate | Only with self-hosted module | Yes | Not confirmed as native/mature | Default path still uses an external provider |
| Pinecone | Yes | No — external SaaS | Not confirmed | Means moving off AWS infrastructure entirely |
| SageMaker (self-hosted OSS model) + OpenSearch | Yes | Yes | No (OpenSearch Serverless blocks the pipeline either way) | Closest to today's architecture, least disruptive |
| Amazon Kendra | N/A — closed to new customers | N/A | N/A | Not viable, verified |
| Amazon Q Business | N/A — closed to new customers | N/A | N/A | Not viable, verified |
| Bedrock AgentCore | No — it is Bedrock | N/A | N/A | Different layer (agent orchestration), not a search alternative |

## Sources

- [Using Large ONNX Models with External Data in Vespa Embedders — Vespa Blog](https://blog.vespa.ai/onnx-external-data-in-vespa-embedders/)
- [Embedding — Vespa Docs](https://docs.vespa.ai/en/rag/embedding.html)
- [Top 15 vector databases in 2026 — production decision guide](https://medium.com/@pratik-rupareliya/top-15-vector-databases-in-2026-a-production-decision-guide-from-100-enterprise-deployments-dd58a04f51a5)
- [Overview — Amazon Bedrock AgentCore Docs](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/what-is-bedrock-agentcore.html)
- [AWS Retires Bedrock Agents: AgentCore Is the New Path](https://enterprisedna.co/resources/news/amazon-bedrock-agents-classic-agentcore-enterprise-july-2026/)
- [Amazon Kendra availability change — AWS Docs](https://docs.aws.amazon.com/kendra/latest/dg/kendra-availability-change.html)
- [Amazon Q Business Closed to New Customers on July 31, 2026 — InSearch](https://insearch.ai/blog/amazon-q-business-closing-to-new-customers)
- [AWS Retires Its First-Gen AI Services: Bedrock Agents, Kendra, and Q Business Enter Maintenance Mode](https://the-agent-report.com/2026/07/aws-ai-services-retirement-bedrock-kendra-q-business-july-2026/)
