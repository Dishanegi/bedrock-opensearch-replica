/**
 * Runs the labeled query set (queries.ts) against the deployed dashboard's
 * /api/compare, scores each mode (dense/ase/hybrid/keyword) per the
 * methodology in docs/sparse-vs-dense-benchmark-plan.md, and writes both a
 * machine-readable JSON result and a markdown report.
 *
 * Focused on NextGen only — Classic-ASE is denied (see the KMS
 * investigation earlier this project), so it's not a fair fourth mode to
 * score there; NextGen's dense/sparse/hybrid/keyword all genuinely work,
 * making it the only tier where this comparison is apples-to-apples.
 *
 * Usage: point at the dashboard through the SSM tunnel (localhost:8080 by
 * default, matching every other manual test this session):
 *   npx ts-node benchmark/run-benchmark.ts
 */
import * as fs from "fs";
import * as path from "path";
import { LABELED_QUERIES, LabeledQuery, QueryCategory } from "./queries";

const BASE_URL = process.env.BENCHMARK_BASE_URL ?? "http://localhost:8080";
const K = 10;

interface SearchResultLike {
  title: string;
}
interface SearchOutcomeLike {
  results: SearchResultLike[];
  error?: string;
}
interface CompareResponseLike {
  nextGen: {
    keyword: SearchOutcomeLike;
    vector: SearchOutcomeLike;
    hybrid: SearchOutcomeLike;
    ase: SearchOutcomeLike;
  };
}

const MODES = ["vector", "ase", "hybrid", "keyword"] as const;
type Mode = (typeof MODES)[number];
const MODE_LABEL: Record<Mode, string> = {
  vector: "Dense (Bedrock/Titan)",
  ase: "Sparse (ASE)",
  hybrid: "Hybrid",
  keyword: "Keyword (BM25)"
};

interface QueryScore {
  query: string;
  category: QueryCategory;
  /** 1-indexed rank of the first correct title, or null if not found in top K. */
  rank: number | null;
}

/** First position (1-indexed) of any correct title in the result list, or null. */
function findRank(results: SearchResultLike[], correctTitles: string[]): number | null {
  for (let i = 0; i < results.length; i++) {
    if (correctTitles.includes(results[i].title)) return i + 1;
  }
  return null;
}

async function runQuery(lq: LabeledQuery): Promise<Record<Mode, QueryScore>> {
  const res = await fetch(`${BASE_URL}/api/compare`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: lq.query, k: K })
  });
  if (!res.ok) throw new Error(`/api/compare failed (${res.status}) for query "${lq.query}"`);
  const data = (await res.json()) as CompareResponseLike;

  const scores = {} as Record<Mode, QueryScore>;
  for (const mode of MODES) {
    const outcome = data.nextGen[mode];
    scores[mode] = {
      query: lq.query,
      category: lq.category,
      rank: outcome.error ? null : findRank(outcome.results, lq.correctTitles)
    };
  }
  return scores;
}

/** Binary-relevance IR metrics — exactly one relevant grade (correct/not),
 *  so Recall@K collapses to "found or not," MRR to 1/rank of the first hit,
 *  and NDCG@K to a single log-discounted term (IDCG@K is always 1, since
 *  the best possible ranking places the one relevant item at position 1). */
function scoreGroup(scores: QueryScore[]): { recallAt10: number; mrr: number; ndcgAt10: number; n: number } {
  const n = scores.length;
  if (n === 0) return { recallAt10: 0, mrr: 0, ndcgAt10: 0, n: 0 };
  let recallSum = 0;
  let mrrSum = 0;
  let ndcgSum = 0;
  for (const s of scores) {
    if (s.rank !== null) {
      recallSum += 1;
      mrrSum += 1 / s.rank;
      ndcgSum += 1 / Math.log2(s.rank + 1);
    }
  }
  return { recallAt10: recallSum / n, mrr: mrrSum / n, ndcgAt10: ndcgSum / n, n };
}

async function main() {
  console.log(`[benchmark] running ${LABELED_QUERIES.length} labeled queries against ${BASE_URL} (k=${K})...`);

  const perModeScores: Record<Mode, QueryScore[]> = { vector: [], ase: [], hybrid: [], keyword: [] };

  for (const [i, lq] of LABELED_QUERIES.entries()) {
    process.stdout.write(`  [${i + 1}/${LABELED_QUERIES.length}] ${lq.category}: "${lq.query}"\n`);
    const scores = await runQuery(lq);
    for (const mode of MODES) perModeScores[mode].push(scores[mode]);
  }

  const categories: QueryCategory[] = ["identifier", "paraphrase", "log", "mixed"];
  interface ResultRow {
    category: QueryCategory | "overall";
    mode: Mode;
    recallAt10: number;
    mrr: number;
    ndcgAt10: number;
    n: number;
  }
  const rows: ResultRow[] = [];

  for (const mode of MODES) {
    for (const category of categories) {
      const subset = perModeScores[mode].filter(s => s.category === category);
      rows.push({ category, mode, ...scoreGroup(subset) });
    }
    rows.push({ category: "overall", mode, ...scoreGroup(perModeScores[mode]) });
  }

  const outDir = path.join(__dirname, "results");
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, "results.json");
  fs.writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), k: K, rows }, null, 2));

  const mdLines: string[] = [];
  mdLines.push("# Dense vs. Sparse (ASE) vs. Hybrid vs. Keyword — retrieval benchmark");
  mdLines.push("");
  mdLines.push(`Run against NextGen, ${LABELED_QUERIES.length} labeled queries, k=${K}. See docs/sparse-vs-dense-benchmark-plan.md for methodology.`);
  mdLines.push("");
  for (const category of [...categories, "overall" as const]) {
    mdLines.push(`## ${category === "overall" ? "Overall" : category}`);
    mdLines.push("");
    mdLines.push("| Mode | Recall@10 | MRR | NDCG@10 | n |");
    mdLines.push("|---|---|---|---|---|");
    for (const mode of MODES) {
      const row = rows.find(r => r.category === category && r.mode === mode)!;
      mdLines.push(
        `| ${MODE_LABEL[mode]} | ${row.recallAt10.toFixed(2)} | ${row.mrr.toFixed(2)} | ${row.ndcgAt10.toFixed(2)} | ${row.n} |`
      );
    }
    mdLines.push("");
  }
  const mdPath = path.join(outDir, "report.md");
  fs.writeFileSync(mdPath, mdLines.join("\n"));

  console.log(`[benchmark] done. Wrote ${jsonPath} and ${mdPath}`);
}

main().catch(err => {
  console.error("[benchmark] failed:", err);
  process.exit(1);
});
