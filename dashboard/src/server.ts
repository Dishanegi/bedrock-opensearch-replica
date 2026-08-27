import path from "path";
import express, { Request, Response } from "express";
import { generateEmbedding } from "./embed";
import { CollectionClient, SearchOutcome } from "./opensearch";
import { getSeedProgress, runSeedJob } from "./seed";

const PORT = Number(process.env.PORT ?? "3000");
const EMBEDDING_DIMENSION = Number(process.env.EMBEDDING_DIMENSION ?? "1024");
const SEED_COUNT = Number(process.env.SEED_COUNT ?? "2000");

const CLASSIC_ENDPOINT = process.env.CLASSIC_OPENSEARCH_ENDPOINT ?? "";
const CLASSIC_INDEX_NAME = process.env.CLASSIC_INDEX_NAME ?? "replica-findings-kg";
const NEXTGEN_ENDPOINT = process.env.NEXTGEN_OPENSEARCH_ENDPOINT ?? "";
const NEXTGEN_INDEX_NAME = process.env.NEXTGEN_INDEX_NAME ?? "replica-findings-kg";

const DOCUMENTS_BUCKET_NAME = process.env.DOCUMENTS_BUCKET_NAME ?? "";
const DOCUMENTS_PREFIX = process.env.DOCUMENTS_PREFIX ?? "jobs/";
const DOCUMENTS_TABLE_NAME = process.env.DOCUMENTS_TABLE_NAME ?? "";

if (!CLASSIC_ENDPOINT || !NEXTGEN_ENDPOINT) {
  console.error("[dashboard] CLASSIC_OPENSEARCH_ENDPOINT and NEXTGEN_OPENSEARCH_ENDPOINT are both required");
  process.exit(1);
}
if (!DOCUMENTS_BUCKET_NAME || !DOCUMENTS_TABLE_NAME) {
  console.error("[dashboard] DOCUMENTS_BUCKET_NAME and DOCUMENTS_TABLE_NAME are both required");
  process.exit(1);
}

// Classic supports the Engine property on knn_vector fields; NextGen doesn't
// (verified empirically earlier in this project) — see CollectionClient.
const classic = new CollectionClient(CLASSIC_ENDPOINT, CLASSIC_INDEX_NAME, true);
const nextGen = new CollectionClient(NEXTGEN_ENDPOINT, NEXTGEN_INDEX_NAME, false);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

// Fire-and-forget: at ~1s/embedding call, SEED_COUNT (2000 by default)
// findings takes ~30+ minutes — far longer than the ALB's default 60s idle
// timeout would tolerate on a single held-open request. Returns immediately;
// poll /api/seed/status for progress instead.
app.post("/api/seed", (_req: Request, res: Response) => {
  const current = getSeedProgress();
  if (current.status === "running") {
    res.status(409).json({ error: "A seed job is already running", progress: current });
    return;
  }
  console.log(`[dashboard] starting seed job for ${SEED_COUNT} findings...`);
  void runSeedJob(
    classic,
    nextGen,
    EMBEDDING_DIMENSION,
    { bucket: DOCUMENTS_BUCKET_NAME, prefix: DOCUMENTS_PREFIX, tableName: DOCUMENTS_TABLE_NAME },
    SEED_COUNT
  );
  res.status(202).json({ status: "started", total: SEED_COUNT });
});

app.get("/api/seed/status", (_req: Request, res: Response) => {
  res.json(getSeedProgress());
});

interface CompareResponse {
  classic: { keyword: SearchOutcome; vector: SearchOutcome; hybrid: SearchOutcome };
  nextGen: { keyword: SearchOutcome; vector: SearchOutcome; hybrid: SearchOutcome };
}

app.post("/api/compare", async (req: Request, res: Response) => {
  const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
  if (!query) {
    res.status(400).json({ error: "query is required" });
    return;
  }

  try {
    // Embed once via Bedrock, reuse the same vector against both collections
    // — the text is identical, no reason to pay for two InvokeModel calls.
    const embedding = await generateEmbedding(query);

    const [classicKeyword, classicVector, classicHybrid, nextGenKeyword, nextGenVector, nextGenHybrid] =
      await Promise.all([
        classic.bm25Search(query),
        classic.knnSearch(embedding),
        classic.hybridSearch(query, embedding),
        nextGen.bm25Search(query),
        nextGen.knnSearch(embedding),
        nextGen.hybridSearch(query, embedding)
      ]);

    const response: CompareResponse = {
      classic: { keyword: classicKeyword, vector: classicVector, hybrid: classicHybrid },
      nextGen: { keyword: nextGenKeyword, vector: nextGenVector, hybrid: nextGenHybrid }
    };
    res.json(response);
  } catch (err) {
    console.error("[dashboard] compare failed:", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

app.listen(PORT, () => {
  console.log(`[dashboard] listening on port ${PORT}`);
});
