import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const BUCKET = process.env.DOCUMENTS_BUCKET_NAME ?? "";
const PREFIX = process.env.DOCUMENTS_PREFIX ?? "jobs/";

const s3 = new S3Client({ region: REGION });

/**
 * Same finding shape as harness-findings in the reference codebase, plus
 * four replica-specific additions not present in the production schema:
 * classification, summary, remediation, riskScore — a richer per-finding
 * detail set closer to what a real FINDINGS_SUMMARY.json carries. All four
 * are optional so existing minimal findings (just the core 7 fields) still
 * satisfy this type.
 */
export interface Finding {
  findingId: string;
  title: string;
  severity: string;
  assetName: string;
  jobId: string;
  cwe?: string;
  createdAt?: string;
  /** Category label, e.g. "Network Security", "Identity & Access Management". */
  classification?: string;
  /** Longer free-text description of the finding, beyond the short title. */
  summary?: string;
  /** Short recommended-fix text. */
  remediation?: string;
  /** 0-100 risk score, distinct from the categorical severity field. */
  riskScore?: number;
}

/**
 * Reads every `{assetSlug}/FINDINGS_SUMMARY.json` object under
 * DOCUMENTS_PREFIX — same shape as pentesting-agentic-harness-infra's
 * `jobs/{assetSlug}/FINDINGS_SUMMARY.json`, read there via
 * `parseFindings()` (containers/runner-core/src/runner-output.ts), which
 * takes the file's top-level `findings` array (falling back to `[]` if it's
 * not an array — the same guard is applied here).
 *
 * A finding's `jobId` is taken from the finding object itself when present
 * (as in production, where each item already carries its own `jobId`); if
 * absent, it falls back to the `assetSlug` path segment between the prefix
 * and the filename, since this replica has no job-orchestration layer to
 * source a real job id from — each `FINDINGS_SUMMARY.json` file is treated
 * as its own logical "job" for idempotent-clear purposes.
 *
 * No pagination beyond a single ListObjectsV2 call — fine for a
 * replica/demo; the reference backfill_kg.py handles pagination for real
 * production volume.
 */
export async function readS3Documents(): Promise<Finding[]> {
  if (!BUCKET) return [];

  const listing = await s3.send(
    new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX })
  );

  const keys = (listing.Contents ?? [])
    .map(obj => obj.Key)
    .filter((key): key is string => !!key && key.endsWith("FINDINGS_SUMMARY.json"));

  const findings: Finding[] = [];
  for (const key of keys) {
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const text = await obj.Body?.transformToString("utf-8");
    if (!text) continue;

    const data = JSON.parse(text) as { findings?: unknown };
    const rawFindings = Array.isArray(data.findings) ? data.findings : [];

    // assetSlug = path segment between PREFIX and "FINDINGS_SUMMARY.json",
    // e.g. "jobs/my-asset/FINDINGS_SUMMARY.json" -> "my-asset".
    const assetSlug = key.slice(PREFIX.length, key.length - "/FINDINGS_SUMMARY.json".length);

    for (const raw of rawFindings) {
      const f = raw as Partial<Finding>;
      if (!f.findingId || !f.title || !f.severity) continue;
      findings.push({
        findingId: f.findingId,
        title: f.title,
        severity: f.severity,
        assetName: f.assetName ?? assetSlug,
        jobId: f.jobId ?? assetSlug,
        cwe: f.cwe,
        createdAt: f.createdAt,
        classification: f.classification,
        summary: f.summary,
        remediation: f.remediation,
        riskScore: f.riskScore
      });
    }
  }
  return findings;
}
