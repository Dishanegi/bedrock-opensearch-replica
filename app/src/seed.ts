import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Finding } from "./s3-source";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const BUCKET = process.env.DOCUMENTS_BUCKET_NAME ?? "";
const PREFIX = process.env.DOCUMENTS_PREFIX ?? "jobs/";
const TABLE_NAME = process.env.DOCUMENTS_TABLE_NAME ?? "";

const s3 = new S3Client({ region: REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

/**
 * Standalone seed entrypoint — not run by index.ts's main(). Pushes findings
 * into S3 and/or DynamoDB so the connector (index.ts) has something to read
 * on its next run. Not wired into ComputeStack's default CMD; invoke it
 * directly (locally via `npm run seed`, or as an ECS run-task command
 * override once ComputeStack is deployed).
 *
 * Real, distinct cloud-security finding types — generateDummyFindings()
 * cycles through this pool to produce bulk dummy data. Each entry carries:
 *  - title/severity/cwe: the original core fields
 *  - classification: a fixed category label (8 categories used across the
 *    pool — Identity & Access Management, Network Security, Data Protection,
 *    Encryption & Key Management, Logging & Monitoring, Application Security,
 *    Container & Registry Security, Configuration Management)
 *  - summary: a longer description of the finding, closer to what a real
 *    scanner's FINDINGS_SUMMARY.json carries per finding beyond just a title
 *  - remediation: a short recommended fix
 * riskScore is NOT part of the template — it's computed per-finding in
 * generateDummyFindings() from severity, with jitter, so it isn't identical
 * across every finding of the same vulnerability type.
 * Replace this pool (or generateDummyFindings entirely) once real findings
 * data is available.
 */
const VULNERABILITY_TEMPLATES: ReadonlyArray<{
  title: string;
  severity: string;
  cwe: string;
  classification: string;
  summary: string;
  remediation: string;
}> = [
  { title: "S3 bucket allows public read access", severity: "high", cwe: "CWE-284", classification: "Data Protection", summary: "The bucket's ACL or bucket policy grants read access to any unauthenticated principal (AllUsers/AllAuthenticatedUsers), exposing its contents to the public internet.", remediation: "Block public access at the bucket level and remove any policy statements granting AllUsers/AllAuthenticatedUsers permissions." },
  { title: "S3 bucket allows public write access", severity: "critical", cwe: "CWE-284", classification: "Data Protection", summary: "The bucket's policy allows any principal to upload or overwrite objects, risking data tampering or malicious content injection.", remediation: "Enable S3 Block Public Access and restrict PutObject/PutObjectAcl to specific, trusted principals only." },
  { title: "S3 bucket not encrypted with a customer-managed KMS key", severity: "medium", cwe: "CWE-311", classification: "Encryption & Key Management", summary: "The bucket uses default (SSE-S3) or no server-side encryption instead of a customer-managed KMS key, limiting control over key rotation and access auditing.", remediation: "Enable default encryption on the bucket using a customer-managed KMS key and enforce it via bucket policy." },
  { title: "S3 bucket versioning disabled", severity: "low", cwe: "CWE-693", classification: "Data Protection", summary: "Without versioning enabled, accidental deletions or overwrites of objects in this bucket cannot be recovered.", remediation: "Enable versioning on the bucket and configure a lifecycle policy to manage noncurrent versions." },
  { title: "IAM user has console access without MFA enabled", severity: "high", cwe: "CWE-308", classification: "Identity & Access Management", summary: "This IAM user can sign in to the AWS Management Console using only a password, with no multi-factor authentication configured.", remediation: "Enforce MFA for all IAM users with console access via an IAM policy condition or Organizations SCP." },
  { title: "IAM policy grants wildcard (*) permissions on all resources", severity: "critical", cwe: "CWE-732", classification: "Identity & Access Management", summary: "The attached policy uses Action:* and/or Resource:*, granting far broader permissions than the principal requires.", remediation: "Scope the policy down to the specific actions and resource ARNs actually needed, following least privilege." },
  { title: "IAM access key not rotated in over 90 days", severity: "medium", cwe: "CWE-798", classification: "Identity & Access Management", summary: "This access key has been active for more than 90 days without rotation, increasing the impact window if it were ever leaked.", remediation: "Rotate the access key and implement an automated rotation schedule using IAM credential reports." },
  { title: "Root account has active access keys", severity: "critical", cwe: "CWE-250", classification: "Identity & Access Management", summary: "Long-lived access keys exist for the AWS account's root user, which should never be used for programmatic access.", remediation: "Delete the root account's access keys immediately and rely on IAM roles/users for all programmatic access." },
  { title: "Security group allows unrestricted inbound SSH (0.0.0.0/0:22)", severity: "critical", cwe: "CWE-284", classification: "Network Security", summary: "Port 22 is open to 0.0.0.0/0, allowing SSH connection attempts from any IP address on the internet.", remediation: "Restrict the security group's SSH rule to specific trusted CIDR ranges or route access through a bastion/SSM Session Manager." },
  { title: "Security group allows unrestricted inbound RDP (0.0.0.0/0:3389)", severity: "critical", cwe: "CWE-284", classification: "Network Security", summary: "Port 3389 is open to 0.0.0.0/0, exposing this instance's remote desktop service to the entire internet.", remediation: "Restrict RDP access to specific trusted CIDR ranges or require connection via a VPN/bastion host." },
  { title: "Security group allows all inbound traffic from any source", severity: "critical", cwe: "CWE-284", classification: "Network Security", summary: "This security group has a rule permitting all protocols and ports from 0.0.0.0/0, effectively removing network-layer access control.", remediation: "Replace the broad rule with narrowly scoped rules for only the ports and source ranges actually required." },
  { title: "EC2 instance has a public IP address with no documented justification", severity: "medium", cwe: "CWE-668", classification: "Network Security", summary: "This instance is assigned a public IP address, but no business justification for direct internet exposure is on record.", remediation: "Move the instance to a private subnet behind a NAT gateway/load balancer, or document and approve the public exposure." },
  { title: "EBS volume not encrypted at rest", severity: "high", cwe: "CWE-311", classification: "Data Protection", summary: "This EBS volume was created without encryption enabled, leaving data at rest unprotected if the underlying storage is ever compromised.", remediation: "Enable EBS encryption by default for the account/region and re-create the volume from an encrypted snapshot." },
  { title: "RDS instance is publicly accessible", severity: "critical", cwe: "CWE-284", classification: "Network Security", summary: "The RDS instance's PubliclyAccessible flag is set to true, exposing its endpoint to connections from outside the VPC.", remediation: "Disable public accessibility and connect to the database only through the VPC or a peered/VPN network." },
  { title: "RDS instance not encrypted at rest", severity: "high", cwe: "CWE-311", classification: "Data Protection", summary: "This RDS instance was launched without storage encryption enabled, leaving its data files unencrypted on disk.", remediation: "Enable encryption at rest for future instances by default; migrate this one to a new encrypted instance via snapshot copy." },
  { title: "RDS instance automated backups disabled", severity: "medium", cwe: "CWE-693", classification: "Configuration Management", summary: "The backup retention period is set to zero, meaning no automated daily backups or point-in-time recovery are available.", remediation: "Set a backup retention period of at least 7 days and enable automated backups." },
  { title: "RDS instance using default master username", severity: "low", cwe: "CWE-798", classification: "Identity & Access Management", summary: "The instance still uses the default master username (e.g., admin/postgres), making credential-guessing attacks easier.", remediation: "Rotate to a non-default master username where supported, and enforce a strong, rotated master password." },
  { title: "CloudTrail logging disabled in region", severity: "high", cwe: "CWE-778", classification: "Logging & Monitoring", summary: "No active CloudTrail trail is capturing API activity in this region, leaving actions here without an audit trail.", remediation: "Enable a multi-region CloudTrail trail that covers all regions and delivers logs to a centralized, access-controlled bucket." },
  { title: "CloudTrail log file validation disabled", severity: "medium", cwe: "CWE-345", classification: "Logging & Monitoring", summary: "Log file integrity validation is turned off for this trail, making undetected tampering with delivered log files possible.", remediation: "Enable log file validation on the CloudTrail trail to detect any post-delivery modification." },
  { title: "CloudTrail logs not encrypted with KMS", severity: "medium", cwe: "CWE-311", classification: "Encryption & Key Management", summary: "CloudTrail log files are being delivered to S3 without KMS encryption, relying only on default S3 server-side encryption.", remediation: "Configure the trail to encrypt log files with a dedicated customer-managed KMS key." },
  { title: "KMS key rotation disabled", severity: "medium", cwe: "CWE-320", classification: "Encryption & Key Management", summary: "Automatic annual key rotation is not enabled for this customer-managed KMS key.", remediation: "Enable automatic key rotation on the KMS key to limit the exposure window of any single key material version." },
  { title: "KMS key policy allows overly permissive cross-account access", severity: "high", cwe: "CWE-284", classification: "Encryption & Key Management", summary: "The key policy grants decrypt/use permissions to a broad set of principals, including external accounts, beyond what is required.", remediation: "Scope the key policy to only the specific accounts/roles that legitimately need to use this key." },
  { title: "Lambda function has an overly permissive execution role", severity: "high", cwe: "CWE-732", classification: "Identity & Access Management", summary: "The function's execution role is attached to broad managed policies (e.g., AdministratorAccess) rather than the specific permissions it needs.", remediation: "Replace the broad policy with a scoped, function-specific IAM policy following least privilege." },
  { title: "Lambda function environment variables contain plaintext secrets", severity: "critical", cwe: "CWE-798", classification: "Data Protection", summary: "Sensitive values such as API keys or database passwords are stored directly in the function's environment variables without encryption.", remediation: "Move secrets to AWS Secrets Manager or Parameter Store and reference them at runtime instead of storing them in plaintext." },
  { title: "Lambda function URL configured with public access", severity: "high", cwe: "CWE-284", classification: "Network Security", summary: "The function URL's auth type is set to NONE, allowing anyone on the internet to invoke this function directly.", remediation: "Set the function URL's auth type to AWS_IAM or front it with an authenticated API Gateway." },
  { title: "VPC flow logs disabled", severity: "medium", cwe: "CWE-778", classification: "Logging & Monitoring", summary: "No flow logs are configured for this VPC, so network traffic metadata isn't being captured for investigation or anomaly detection.", remediation: "Enable VPC Flow Logs and deliver them to CloudWatch Logs or S3 for retention and analysis." },
  { title: "Default VPC security group allows all traffic", severity: "medium", cwe: "CWE-284", classification: "Network Security", summary: "The VPC's default security group still has its original permissive rule allowing all traffic between members of the group.", remediation: "Remove the default security group's permissive rules and avoid using the default SG for any real workloads." },
  { title: "Elastic IP allocated but not associated with a running instance", severity: "low", cwe: "CWE-1059", classification: "Configuration Management", summary: "This Elastic IP is allocated to the account but not attached to any running instance or network interface, incurring unnecessary charges.", remediation: "Release the unused Elastic IP or associate it with the intended resource." },
  { title: "EKS cluster endpoint publicly accessible without CIDR restriction", severity: "critical", cwe: "CWE-284", classification: "Container & Registry Security", summary: "The cluster's API server endpoint is reachable from the public internet with no CIDR allow-list restricting source IPs.", remediation: "Restrict the public endpoint to specific CIDR ranges, or disable it in favor of private endpoint access only." },
  { title: "EKS cluster control plane logging disabled", severity: "medium", cwe: "CWE-778", classification: "Logging & Monitoring", summary: "Control plane log types (e.g., audit, authenticator) are not enabled for this cluster, limiting visibility into cluster-level activity.", remediation: "Enable all relevant EKS control plane log types and route them to CloudWatch Logs." },
  { title: "ECR repository image scanning on push disabled", severity: "medium", cwe: "CWE-1104", classification: "Container & Registry Security", summary: "Images pushed to this repository are not automatically scanned for known vulnerabilities.", remediation: "Enable scan-on-push for the repository, or run scheduled enhanced scanning via Amazon Inspector." },
  { title: "ECR repository policy allows unauthenticated pull access", severity: "high", cwe: "CWE-284", classification: "Container & Registry Security", summary: "The repository policy permits image pulls without requiring authentication, exposing container images to anyone.", remediation: "Remove any wildcard principal from the repository policy and require authenticated, scoped access." },
  { title: "Secrets Manager secret not configured for automatic rotation", severity: "medium", cwe: "CWE-798", classification: "Identity & Access Management", summary: "This secret has no rotation Lambda or schedule configured, so its value never changes unless rotated manually.", remediation: "Configure automatic rotation with an appropriate rotation Lambda for this secret type." },
  { title: "Secrets Manager secret accessible without a restrictive resource policy", severity: "high", cwe: "CWE-284", classification: "Identity & Access Management", summary: "The secret has no resource policy restricting which principals may retrieve its value, relying only on IAM policy grants.", remediation: "Attach a resource policy to the secret that explicitly scopes access to the specific roles that need it." },
  { title: "Hardcoded credentials found in application source code", severity: "critical", cwe: "CWE-798", classification: "Data Protection", summary: "A literal API key, password, or token was found committed directly in the application's source code.", remediation: "Revoke and rotate the exposed credential immediately, then move secret storage to Secrets Manager/Parameter Store." },
  { title: "API Gateway endpoint deployed without an authorizer", severity: "high", cwe: "CWE-306", classification: "Application Security", summary: "This API Gateway route has no Lambda, JWT, or IAM authorizer attached, allowing unauthenticated invocation.", remediation: "Attach an appropriate authorizer to the route and verify authentication/authorization before it reaches backend logic." },
  { title: "API Gateway stage lacks request throttling", severity: "medium", cwe: "CWE-770", classification: "Application Security", summary: "No throttling limits are configured on this stage, leaving the backend exposed to traffic spikes or abuse.", remediation: "Configure stage-level throttling (rate and burst limits) appropriate to the backend's capacity." },
  { title: "WAF not associated with a public-facing load balancer", severity: "medium", cwe: "CWE-693", classification: "Application Security", summary: "This internet-facing load balancer has no AWS WAF web ACL attached to filter malicious requests.", remediation: "Associate a WAF web ACL with appropriate managed rule groups to the load balancer." },
  { title: "Application Load Balancer listener uses an outdated TLS policy", severity: "high", cwe: "CWE-326", classification: "Encryption & Key Management", summary: "The HTTPS listener is configured with a legacy TLS security policy that permits outdated protocol versions or weak ciphers.", remediation: "Update the listener's SSL policy to a current ELBSecurityPolicy that requires TLS 1.2 or higher." },
  { title: "CloudFront distribution uses an outdated TLS security policy", severity: "medium", cwe: "CWE-326", classification: "Encryption & Key Management", summary: "The distribution's viewer/origin TLS policy allows older protocol versions, weakening the confidentiality of traffic in transit.", remediation: "Update the distribution's minimum TLS protocol version to TLSv1.2_2021 or later." },
  { title: "CloudFront distribution missing origin access control for its S3 origin", severity: "medium", cwe: "CWE-284", classification: "Data Protection", summary: "The distribution's S3 origin can still be accessed directly, bypassing CloudFront's caching and access controls, because no OAC/OAI is configured.", remediation: "Configure Origin Access Control and update the bucket policy to allow access only via CloudFront." },
  { title: "SNS topic policy allows Publish from any AWS account", severity: "high", cwe: "CWE-284", classification: "Application Security", summary: "The topic's resource policy grants sns:Publish to Principal: * or a wildcard AWS account, allowing any account to send messages to it.", remediation: "Restrict the topic policy's Publish permission to specific, trusted account IDs or IAM roles." },
  { title: "SQS queue policy allows unrestricted access", severity: "high", cwe: "CWE-284", classification: "Application Security", summary: "The queue's resource policy grants broad permissions to any principal, allowing unauthorized read or write of messages.", remediation: "Scope the queue policy down to the specific principals and actions actually required." },
  { title: "DynamoDB table not encrypted with a customer-managed KMS key", severity: "low", cwe: "CWE-311", classification: "Encryption & Key Management", summary: "This table relies on AWS-owned encryption keys rather than a customer-managed KMS key, limiting key-level access control.", remediation: "Enable encryption at rest using a customer-managed KMS key for tables holding sensitive data." },
  { title: "DynamoDB point-in-time recovery disabled", severity: "low", cwe: "CWE-693", classification: "Configuration Management", summary: "Point-in-time recovery is not enabled, so the table cannot be restored to a specific second within the last 35 days if data is corrupted or deleted.", remediation: "Enable point-in-time recovery on the table." },
  { title: "EC2 access not enforced through Systems Manager Session Manager", severity: "low", cwe: "CWE-284", classification: "Identity & Access Management", summary: "Direct SSH/RDP access remains available for this instance instead of routing interactive access through SSM Session Manager.", remediation: "Install the SSM Agent, remove inbound SSH/RDP rules, and require Session Manager for interactive access." },
  { title: "AWS Config not enabled in all regions", severity: "medium", cwe: "CWE-778", classification: "Logging & Monitoring", summary: "AWS Config is not recording resource configuration changes in every region the account uses.", remediation: "Enable AWS Config with an aggregator covering all active regions." },
  { title: "GuardDuty not enabled in the account", severity: "high", cwe: "CWE-778", classification: "Logging & Monitoring", summary: "Amazon GuardDuty threat detection is not enabled for this account, so malicious or anomalous activity may go undetected.", remediation: "Enable GuardDuty in all active regions and route findings to a central security account." },
  { title: "Security Hub not enabled in the account", severity: "medium", cwe: "CWE-778", classification: "Logging & Monitoring", summary: "AWS Security Hub is not aggregating security findings and compliance status for this account.", remediation: "Enable Security Hub with the relevant standards (e.g., CIS, AWS Foundational Security Best Practices)." },
  { title: "IAM password policy does not enforce minimum complexity requirements", severity: "medium", cwe: "CWE-521", classification: "Identity & Access Management", summary: "The account's IAM password policy allows short or simple passwords, falling short of common complexity baselines.", remediation: "Update the account password policy to require minimum length, character variety, and periodic rotation." },
  { title: "Unused IAM role with attached policies not removed", severity: "low", cwe: "CWE-1059", classification: "Identity & Access Management", summary: "This IAM role has not been used in an extended period but still retains its attached permission policies.", remediation: "Review the role's last-used data and remove it (or its policies) if it's confirmed unused." },
  { title: "Cross-account IAM role trust policy overly permissive", severity: "critical", cwe: "CWE-284", classification: "Identity & Access Management", summary: "The role's trust policy allows assumption from a broad set of principals (or a wildcard), rather than specific trusted accounts/roles.", remediation: "Scope the trust policy's Principal down to the exact external account(s)/role(s) that should assume this role, and add an ExternalId condition." },
  { title: "Network ACL allows unrestricted inbound traffic", severity: "medium", cwe: "CWE-284", classification: "Network Security", summary: "This subnet's network ACL includes a rule allowing all inbound traffic from 0.0.0.0/0, providing no additional network-layer defense beyond security groups.", remediation: "Tighten the network ACL's inbound rules to only the protocols/ports/sources actually required for this subnet." },
  { title: "NAT Gateway not deployed redundantly across Availability Zones", severity: "low", cwe: "CWE-1059", classification: "Configuration Management", summary: "Only a single NAT Gateway serves this VPC's private subnets, creating a single point of failure for outbound connectivity if its AZ has an outage.", remediation: "Deploy one NAT Gateway per Availability Zone and route each private subnet through the NAT Gateway in its own AZ." },
  { title: "OpenSearch domain is publicly accessible", severity: "critical", cwe: "CWE-284", classification: "Network Security", summary: "This OpenSearch domain's access policy or endpoint configuration allows connections from outside the VPC without IP restriction.", remediation: "Move the domain to VPC-only access and restrict its access policy to specific trusted principals." },
  { title: "OpenSearch domain not encrypted at rest", severity: "high", cwe: "CWE-311", classification: "Data Protection", summary: "Encryption at rest is not enabled for this OpenSearch domain, leaving indexed data unencrypted on the underlying storage.", remediation: "Enable encryption at rest (and node-to-node encryption) for the domain; this requires creating a new domain, as it cannot be changed in place." }
];

/** severity -> [min, max] riskScore range, so riskScore correlates with but isn't identical to severity. */
const RISK_SCORE_RANGES: Record<string, [number, number]> = {
  critical: [85, 100],
  high: [65, 84],
  medium: [35, 64],
  low: [5, 34]
};

function computeRiskScore(severity: string): number {
  const [min, max] = RISK_SCORE_RANGES[severity] ?? [0, 100];
  return min + Math.floor(Math.random() * (max - min + 1));
}

const ASSET_NAMES: readonly string[] = [
  "prod-web-server-01", "prod-web-server-02", "staging-web-server-01",
  "prod-api-gateway", "internal-api-gateway",
  "prod-db-primary", "prod-db-replica-01", "staging-db-primary",
  "data-lake-bucket", "user-uploads-bucket", "backup-archive-bucket", "static-assets-bucket",
  "auth-lambda-fn", "image-resize-lambda-fn", "billing-lambda-fn", "notifications-lambda-fn",
  "prod-eks-cluster", "staging-eks-cluster",
  "app-container-registry", "base-image-registry",
  "shared-secrets-store", "db-credentials-store",
  "prod-vpc-default-sg", "management-vpc-default-sg",
  "customer-data-kms-key", "logs-kms-key",
  "orders-search-domain", "logs-search-domain",
  "events-topic", "alerts-topic",
  "jobs-queue", "dead-letter-queue",
  "sessions-table", "audit-log-table", "inventory-table",
  "cdn-distribution", "public-assets-distribution",
  "org-cloudtrail", "management-account-role",
  "ci-cd-deploy-role", "read-only-audit-role",
  "bastion-host", "jump-box-eu",
  "prod-load-balancer", "internal-load-balancer",
  "legacy-file-server", "archived-reporting-db",
  "partner-integration-api", "mobile-backend-api",
  "analytics-pipeline-bucket", "ml-training-bucket"
];

/**
 * Cycles through VULNERABILITY_TEMPLATES/ASSET_NAMES to build `count` dummy
 * findings, spread across 20 jobIds (~50 findings per job) so
 * clearExistingEmbeddings' per-jobId grouping in index.ts has multiple
 * realistic groups to work with. createdAt is randomized over the last 30
 * days.
 */
function generateDummyFindings(count: number): Finding[] {
  const findings: Finding[] = [];
  const findingsPerJob = 50;

  for (let i = 0; i < count; i++) {
    const template = VULNERABILITY_TEMPLATES[i % VULNERABILITY_TEMPLATES.length];
    const assetName = ASSET_NAMES[i % ASSET_NAMES.length];
    const jobNumber = Math.floor(i / findingsPerJob) + 1;
    const daysAgo = Math.floor(Math.random() * 30);

    findings.push({
      findingId: `finding-${String(i + 1).padStart(4, "0")}`,
      title: template.title,
      severity: template.severity,
      assetName,
      jobId: `job-${String(jobNumber).padStart(3, "0")}`,
      cwe: template.cwe,
      createdAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
      classification: template.classification,
      summary: template.summary,
      remediation: template.remediation,
      riskScore: computeRiskScore(template.severity)
    });
  }

  return findings;
}

const findingsToSeed: Finding[] = generateDummyFindings(1000);

/**
 * Groups findings by assetName and writes one FINDINGS_SUMMARY.json per
 * group under `${PREFIX}${assetName}/FINDINGS_SUMMARY.json` — same shape
 * s3-source.ts reads: a top-level `{ findings: [...] }` object.
 */
async function seedS3(findings: Finding[]): Promise<void> {
  if (!BUCKET) {
    console.log("[seed] DOCUMENTS_BUCKET_NAME not set — skipping S3");
    return;
  }

  const byAsset = new Map<string, Finding[]>();
  for (const finding of findings) {
    const assetSlug = finding.assetName || "unassigned";
    const group = byAsset.get(assetSlug) ?? [];
    group.push(finding);
    byAsset.set(assetSlug, group);
  }

  for (const [assetSlug, group] of byAsset) {
    const key = `${PREFIX}${assetSlug}/FINDINGS_SUMMARY.json`;
    console.log(`[seed] writing ${group.length} finding(s) to s3://${BUCKET}/${key}`);
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: JSON.stringify({ findings: group }, null, 2),
        ContentType: "application/json"
      })
    );
  }
}

const DYNAMODB_BATCH_SIZE = 25; // BatchWriteItem's hard per-request limit

/**
 * Writes in chunks of 25 (DynamoDB's BatchWriteItem limit) instead of one
 * PutCommand per finding — for 1000 items that's 40 requests instead of
 * 1000. Retries any UnprocessedItems (DynamoDB returns these under
 * throttling/capacity pressure) up to 3 times with a short backoff.
 */
async function seedDynamoDb(findings: Finding[]): Promise<void> {
  if (!TABLE_NAME) {
    console.log("[seed] DOCUMENTS_TABLE_NAME not set — skipping DynamoDB");
    return;
  }

  for (let i = 0; i < findings.length; i += DYNAMODB_BATCH_SIZE) {
    const chunk = findings.slice(i, i + DYNAMODB_BATCH_SIZE);
    let requestItems: { PutRequest: { Item: Record<string, unknown> } }[] = chunk.map(finding => ({
      PutRequest: { Item: finding as unknown as Record<string, unknown> }
    }));

    for (let attempt = 1; requestItems.length > 0 && attempt <= 3; attempt++) {
      const result = await ddb.send(new BatchWriteCommand({ RequestItems: { [TABLE_NAME]: requestItems } }));
      requestItems = (result.UnprocessedItems?.[TABLE_NAME] ?? []) as { PutRequest: { Item: Record<string, unknown> } }[];
      if (requestItems.length > 0) {
        await new Promise(resolve => setTimeout(resolve, attempt * 250));
      }
    }

    if (requestItems.length > 0) {
      console.warn(`[seed] ${requestItems.length} item(s) in batch starting at index ${i} still unprocessed after retries`);
    }

    console.log(`[seed] wrote batch ${i / DYNAMODB_BATCH_SIZE + 1}/${Math.ceil(findings.length / DYNAMODB_BATCH_SIZE)} to DynamoDB table ${TABLE_NAME}`);
  }
}

/**
 * Split, not duplicated, across the two sources — findingId is not used as
 * the OpenSearch document _id (AOSS Serverless doesn't support a
 * client-supplied _id on index ops; see opensearch.ts), so a finding written
 * to both S3 and DynamoDB would be indexed as two separate documents. Each
 * finding here goes to exactly one source, so index.ts's merged read across
 * both ends up with exactly `findingsToSeed.length` documents, not double.
 */
const S3_SHARE = 0.5;

/** Exported (not auto-run on import) so seed-and-ingest.ts can sequence this before ingest()'s main(). */
export async function main(): Promise<void> {
  if (findingsToSeed.length === 0) {
    console.log("[seed] findingsToSeed is empty — nothing to do. Fill in the array in app/src/seed.ts first.");
    return;
  }

  const splitIndex = Math.floor(findingsToSeed.length * S3_SHARE);
  const forS3 = findingsToSeed.slice(0, splitIndex);
  const forDynamoDb = findingsToSeed.slice(splitIndex);

  console.log(
    `[seed] seeding ${forS3.length} finding(s) into S3 and ${forDynamoDb.length} finding(s) into DynamoDB (${findingsToSeed.length} total, no overlap)...`
  );
  await Promise.all([seedS3(forS3), seedDynamoDb(forDynamoDb)]);
  console.log("[seed] done.");
}

// Only auto-run when this file is the process entrypoint (`node dist/seed.js`
// / `npm run seed`) — not when imported by seed-and-ingest.ts.
if (require.main === module) {
  main().catch(err => {
    console.error("[seed] fatal error:", err);
    process.exit(1);
  });
}
