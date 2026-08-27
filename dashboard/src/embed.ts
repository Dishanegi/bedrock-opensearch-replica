import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const EMBEDDING_MODEL = "amazon.titan-embed-text-v2:0";

const bedrockClient = new BedrockRuntimeClient({ region: REGION });

/** Same call shape as app/src/embed.ts's generateEmbedding() — this component
 *  is a self-contained, independently Dockerized package (like app/), so it
 *  duplicates rather than imports across package boundaries. */
export async function generateEmbedding(text: string): Promise<number[]> {
  const payload = { inputText: text.slice(0, 8192) };

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

export const EMBEDDING_MODEL_ID = EMBEDDING_MODEL;
