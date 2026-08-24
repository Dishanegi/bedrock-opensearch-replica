import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { appConfig } from "./config";

/**
 * The two data entry points that feed the connector — the actual sources of
 * the text that eventually gets embedded and written to OpenSearch.
 *
 * Mirrors the two patterns found in pentesting-agentic-harness-infra:
 *  - S3, read the way skills-and-assets/skills/backfill-data/backfill_kg.py
 *    does: a canonical prefix of one-document-per-object files
 *    (there: `jobs/{slug}/reports_deduplicated/finding_*.md`; here, a
 *    generic `documents/` prefix, plain text or markdown objects).
 *  - DynamoDB, read the way
 *    skills-and-assets/skills/aggressive-dedup/rededup_main.py reads
 *    `harness-findings` — this table shares that exact name and item shape
 *    (findingId partition key, plus title/severity/assetName/jobId/cwe/
 *    createdAt), scanned in full.
 *
 * No dependency on IamStack/NetworkStack/etc — intentionally standalone.
 * Least-privilege grants to the connector's task role happen in bin/app.ts
 * via bucket.grantRead()/table.grantReadData() after both this stack and
 * IamStack exist, rather than baking wildcard S3/DynamoDB permissions into
 * IamStack itself (unlike the Bedrock/AOSS permissions, which use wildcard
 * resources because that's what the reference codebase's own IAM statements
 * do for those two services specifically).
 */
export class DataStack extends cdk.Stack {
  public readonly documentsBucket: s3.Bucket;
  public readonly documentsTable: dynamodb.Table;

  /** Objects under this S3 prefix are treated as one-document-per-object. */
  public readonly documentsPrefix = appConfig.data.documentsPrefix;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Deliberately NOT given an explicit bucketName: S3 bucket names must be
    // globally unique across every AWS account on the planet, not just
    // within this account/region. Hardcoding one risks a deploy-time
    // failure if anyone, anywhere, already owns that name — CDK's
    // auto-generated name (stack + logical ID + account/region hash) avoids
    // that collision risk entirely. The CfnOutput below is how you find the
    // actual generated name after deploying, rather than needing to guess.
    this.documentsBucket = new s3.Bucket(this, "DocumentsBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: false,
      // Demo/replica scope — real usage should not auto-destroy source data.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true
    });

    // Table names only need to be unique within one account+region, not
    // globally — safe to fix explicitly, unlike the bucket above.
    this.documentsTable = new dynamodb.Table(this, "DocumentsTable", {
      tableName: appConfig.data.documentsTableName,
      partitionKey: { name: "findingId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // Guaranteed way to find the exact names of both resources — printed by
    // `cdk deploy` and always retrievable via
    // `aws cloudformation describe-stacks --stack-name DataStack`, without
    // needing to guess or dig through the console.
    new cdk.CfnOutput(this, "DocumentsBucketNameOutput", {
      value: this.documentsBucket.bucketName,
      description: "Exact S3 bucket name to look for documents in"
    });
    new cdk.CfnOutput(this, "DocumentsTableNameOutput", {
      value: this.documentsTable.tableName,
      description: "Exact DynamoDB table name to look for documents in"
    });
  }
}
