import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import type { Finding } from "./s3-source";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const TABLE_NAME = process.env.DOCUMENTS_TABLE_NAME ?? "";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

/**
 * Scans the harness-findings table in full — same "flat table of records,
 * scan the whole thing" shape as
 * skills-and-assets/skills/aggressive-dedup/rededup_main.py's usage of
 * `harness-findings` in the reference codebase, and now the same table name
 * and item shape too (findingId partition key, plus
 * title/severity/assetName/jobId/cwe/createdAt). A single Scan, no
 * pagination past the first page — fine for a replica/demo, not for a
 * production-scale table (rededup_main.py's real production usage handles
 * pagination properly; this doesn't, deliberately, to stay in scope).
 *
 * Items missing `findingId`, `title`, or `severity` are skipped rather than
 * failing the scan.
 */
export async function readDynamoDbDocuments(): Promise<Finding[]> {
  if (!TABLE_NAME) return [];

  const result = await client.send(new ScanCommand({ TableName: TABLE_NAME }));

  return (result.Items ?? [])
    .filter(
      (item): item is Finding =>
        typeof item.findingId === "string" &&
        typeof item.title === "string" &&
        typeof item.severity === "string"
    )
    .map(item => ({
      findingId: item.findingId,
      title: item.title,
      severity: item.severity,
      assetName: item.assetName ?? "",
      jobId: item.jobId ?? "",
      cwe: item.cwe,
      createdAt: item.createdAt,
      classification: item.classification,
      summary: item.summary,
      remediation: item.remediation,
      riskScore: item.riskScore
    }));
}
