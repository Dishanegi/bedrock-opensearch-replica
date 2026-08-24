import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import type { Finding } from "./s3-source";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "amazon.titan-embed-text-v2:0";

// Titan's documented absolute input limit — same constant used by every
// call site in pentesting-agentic-harness-infra (kg.ts, kg_writer.py,
// backfill_kg.py all truncate at 8192).
const BEDROCK_INPUT_LIMIT = 8192;

// Same per-finding truncation kg.ts applies before Bedrock's own 8192-char
// cap ever comes into play (2000 < 8192, so this is the binding limit here).
const EMBEDDING_TEXT_LIMIT = 2000;

const bedrockClient = new BedrockRuntimeClient({ region: REGION });

/**
 * Builds the exact text string kg.ts embeds for a finding
 * (`writeUseCaseKnowledgeGraph`, kg.ts:983-988): title, severity, cwe, and
 * assetName, space-joined with no labels, truncated to 2000 chars.
 */
export function buildEmbeddingText(finding: Finding): string {
  return `${finding.title} ${finding.severity} ${finding.cwe ?? ""} ${finding.assetName}`.slice(
    0,
    EMBEDDING_TEXT_LIMIT
  );
}

/**
 * Calls Bedrock InvokeModel to turn text into an embedding vector.
 *
 * Mirrors containers/runner-core/src/kg.ts's generateEmbedding in the
 * reference codebase: same payload shape ({inputText}), same explicit
 * contentType/accept headers, same response shape ({embedding: number[]}).
 *
 * TODO: the reference kg.ts wraps this call with a 25s AbortSignal.timeout
 * and a 5-attempt exponential-backoff retry (only on ThrottlingException /
 * ServiceUnavailableException) — see kg.ts's generateEmbedding for the exact
 * shape. Deliberately omitted here per "structure first" scope; add before
 * running this against real production-scale traffic.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const payload = { inputText: text.slice(0, BEDROCK_INPUT_LIMIT) };

  const res = await bedrockClient.send(
    new InvokeModelCommand({
      modelId: EMBEDDING_MODEL,
      contentType: "application/json",
      accept: "application/json",
      body: Buffer.from(JSON.stringify(payload))
    })
  );

  const body = JSON.parse(Buffer.from(res.body).toString("utf-8")) as { embedding: number[] };
  return body.embedding;
}
