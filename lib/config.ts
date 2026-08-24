import * as logs from "aws-cdk-lib/aws-logs";

/**
 * Every tunable value for this project, in one place — separate from the
 * stack files, which contain only resource-creation logic and import from
 * here rather than hardcoding literals inline.
 *
 * Mirrors pentesting-agentic-harness-infra's own lib/build-config.ts split:
 * config as plain data, logic in the stacks that consume it.
 *
 * To change a name, size, or model — edit this file only. No stack file
 * should ever need editing just to retune a value.
 *
 * One exception to "plain data only": compute.logRetention below uses the
 * aws-cdk-lib logs.RetentionDays enum directly rather than a plain number,
 * because that enum has fixed allowed values (there's no logs.RetentionDays.of(n)
 * factory for arbitrary day counts) — storing the exact enum member here is
 * more honest than pretending it's freely tunable to any integer.
 */
export interface AppConfig {
  readonly network: {
    /** Number of Availability Zones the VPC spans. */
    readonly maxAzs: number;
    /** 0 = no NAT gateways — the VPC is fully private-isolated by design. */
    readonly natGateways: number;
    /** Subnet size for each isolated subnet. */
    readonly subnetCidrMask: number;
    /** Name of the raw AWS::OpenSearchServerless::VpcEndpoint resource. */
    readonly aossVpcEndpointName: string;
  };

  readonly vectorStore: {
    /** AOSS collection name (Type: VECTORSEARCH). */
    readonly collectionName: string;
    /** OpenSearch index name inside that collection — distinct from the
     *  collection name; the AOSS data-access policy wildcards `index/{collectionName}/*`
     *  so this can differ freely without any permission changes.
     *  Production's real index is `harness-findings-kg` — deliberately named
     *  differently here (`replica-findings-kg`) so this demo collection is
     *  never mistaken for the same one. */
    readonly indexName: string;
    /** Vector dimension for the knn_vector field — must match whatever the
     *  embedding model actually returns (Titan Embed Text v2 defaults to
     *  1024 when no `dimensions` parameter is sent; see embed.ts). */
    readonly embeddingDimension: number;
    readonly encryptionPolicyName: string;
    readonly networkPolicyName: string;
    readonly dataAccessPolicyName: string;
  };

  readonly data: {
    /** S3 prefix under which each `{assetSlug}/FINDINGS_SUMMARY.json` lives —
     *  same shape as production's `jobs/{assetSlug}/FINDINGS_SUMMARY.json`
     *  in pentesting-agentic-harness-infra. */
    readonly documentsPrefix: string;
    /** DynamoDB table name — matches production's real table name
     *  (`harness-findings`) and item shape (findingId partition key, plus
     *  title/severity/assetName/jobId/cwe/createdAt), not just an
     *  "equivalent" demo shape. Safe to fix explicitly, since table names
     *  only need to be unique within one account+region, unlike S3 bucket
     *  names (see the note on the bucket in data-stack.ts for why that one
     *  is deliberately left auto-generated instead). */
    readonly documentsTableName: string;
  };

  readonly compute: {
    readonly clusterName: string;
    readonly logGroupName: string;
    /** CloudWatch Logs retention. One of the fixed logs.RetentionDays enum
     *  values — see the note at the top of this file for why this isn't a
     *  plain number. */
    readonly logRetention: logs.RetentionDays;
    readonly taskCpu: number;
    readonly taskMemoryMiB: number;
    /** Bedrock embedding model ID. Same default pentesting-agentic-harness-infra
     *  uses (see EmbeddingModel in its lib/build-config.ts / SKILL_DEVELOPER_CONTRACT.md §5.1). */
    readonly embeddingModel: string;
    /** Placeholder — must be replaced with a real ECR image reference (or
     *  switched to ecs.ContainerImage.fromAsset) before this can deploy.
     *  See README "Deploying it yourself" step 1. */
    readonly containerImagePlaceholder: string;
  };
}

export const appConfig: AppConfig = {
  network: {
    maxAzs: 2,
    natGateways: 0,
    subnetCidrMask: 24,
    aossVpcEndpointName: "replica-aoss-vpce"
  },

  vectorStore: {
    collectionName: "replica-vector-store",
    indexName: "replica-findings-kg",
    embeddingDimension: 1024,
    encryptionPolicyName: "replica-encryption-policy",
    networkPolicyName: "replica-network-policy",
    dataAccessPolicyName: "replica-data-access-policy"
  },

  data: {
    documentsPrefix: "jobs/",
    documentsTableName: "harness-findings"
  },

  compute: {
    clusterName: "bedrock-opensearch-replica",
    logGroupName: "/bedrock-opensearch-replica/connector",
    logRetention: logs.RetentionDays.TWO_WEEKS,
    taskCpu: 512,
    taskMemoryMiB: 1024,
    embeddingModel: "amazon.titan-embed-text-v2:0",
    containerImagePlaceholder: "REPLACE_ME/bedrock-opensearch-replica-connector:latest"
  }
};
