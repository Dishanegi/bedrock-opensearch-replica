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
const CLASSIC_COLLECTION_ID = process.env.CLASSIC_COLLECTION_ID ?? "";
const NEXTGEN_ENDPOINT = process.env.NEXTGEN_OPENSEARCH_ENDPOINT ?? "";
const NEXTGEN_INDEX_NAME = process.env.NEXTGEN_INDEX_NAME ?? "replica-findings-kg";
const NEXTGEN_COLLECTION_ID = process.env.NEXTGEN_COLLECTION_ID ?? "";

const DOCUMENTS_BUCKET_NAME = process.env.DOCUMENTS_BUCKET_NAME ?? "";
const DOCUMENTS_PREFIX = process.env.DOCUMENTS_PREFIX ?? "jobs/";
const DOCUMENTS_TABLE_NAME = process.env.DOCUMENTS_TABLE_NAME ?? "";

if (!CLASSIC_ENDPOINT || !NEXTGEN_ENDPOINT) {
  console.error("[dashboard] CLASSIC_OPENSEARCH_ENDPOINT and NEXTGEN_OPENSEARCH_ENDPOINT are both required");
  process.exit(1);
}
if (!CLASSIC_COLLECTION_ID || !NEXTGEN_COLLECTION_ID) {
  console.error("[dashboard] CLASSIC_COLLECTION_ID and NEXTGEN_COLLECTION_ID are both required");
  process.exit(1);
}
if (!DOCUMENTS_BUCKET_NAME || !DOCUMENTS_TABLE_NAME) {
  console.error("[dashboard] DOCUMENTS_BUCKET_NAME and DOCUMENTS_TABLE_NAME are both required");
  process.exit(1);
}

// Classic supports the Engine property on knn_vector fields; NextGen doesn't
// (verified empirically earlier in this project) — see CollectionClient.
const classic = new CollectionClient(CLASSIC_ENDPOINT, CLASSIC_INDEX_NAME, true, CLASSIC_COLLECTION_ID);
const nextGen = new CollectionClient(NEXTGEN_ENDPOINT, NEXTGEN_INDEX_NAME, false, NEXTGEN_COLLECTION_ID);

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
  classic: { keyword: SearchOutcome; vector: SearchOutcome; hybrid: SearchOutcome; ase: SearchOutcome };
  nextGen: { keyword: SearchOutcome; vector: SearchOutcome; hybrid: SearchOutcome; ase: SearchOutcome };
}

app.post("/api/compare", async (req: Request, res: Response) => {
  const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
  if (!query) {
    res.status(400).json({ error: "query is required" });
    return;
  }
  // Optional result-count override — the UI's default of 5 is fine for
  // eyeballing, but Recall@10/NDCG@10-style benchmarking needs more than 5
  // results to score against. Clamped to a sane range rather than trusting
  // an arbitrary client-supplied number outright.
  const kRaw = Number(req.body?.k);
  const k = Number.isFinite(kRaw) && kRaw > 0 ? Math.min(Math.floor(kRaw), 50) : 5;

  try {
    // Embed once via Bedrock, reuse the same vector against both collections
    // — the text is identical, no reason to pay for two InvokeModel calls.
    // ASE needs no embedding at all — aseSearch sends the raw query text and
    // AOSS rewrites it into a sparse query internally, no Bedrock call.
    const embedding = await generateEmbedding(query);

    const [
      classicKeyword,
      classicVector,
      classicHybrid,
      classicAse,
      nextGenKeyword,
      nextGenVector,
      nextGenHybrid,
      nextGenAse
    ] = await Promise.all([
      classic.bm25Search(query, k),
      classic.knnSearch(embedding, k),
      classic.hybridSearch(query, embedding, k),
      classic.aseSearch(query, k),
      nextGen.bm25Search(query, k),
      nextGen.knnSearch(embedding, k),
      nextGen.hybridSearch(query, embedding, k),
      nextGen.aseSearch(query, k)
    ]);

    const response: CompareResponse = {
      classic: { keyword: classicKeyword, vector: classicVector, hybrid: classicHybrid, ase: classicAse },
      nextGen: { keyword: nextGenKeyword, vector: nextGenVector, hybrid: nextGenHybrid, ase: nextGenAse }
    };
    res.json(response);
  } catch (err) {
    console.error("[dashboard] compare failed:", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

interface CompareAseResponse {
  classic: SearchOutcome;
  nextGen: SearchOutcome;
}

/**
 * ASE-only comparison, deliberately separate from /api/compare rather than
 * a mode filter on it — the whole point of ASE is that it needs no query-time
 * embedding, so this endpoint never calls generateEmbedding()/Bedrock at all,
 * making it both faster and a clean isolated test of ASE specifically
 * (useful right now while ASE's own supported/reason fields are still being
 * worked out — see CollectionClient.ensureAseIndex()).
 */
app.post("/api/compare-ase", async (req: Request, res: Response) => {
  const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
  if (!query) {
    res.status(400).json({ error: "query is required" });
    return;
  }

  try {
    const [classicAse, nextGenAse] = await Promise.all([classic.aseSearch(query), nextGen.aseSearch(query)]);
    const response: CompareAseResponse = { classic: classicAse, nextGen: nextGenAse };
    res.json(response);
  } catch (err) {
    console.error("[dashboard] compare-ase failed:", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

app.listen(PORT, () => {
  console.log(`[dashboard] listening on port ${PORT}`);
});
