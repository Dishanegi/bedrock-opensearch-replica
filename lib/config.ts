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

  readonly nextGenVectorStore: {
    /** NextGen AOSS collection name/group — separate from vectorStore's
     *  Classic collection, deliberately, so the two can be torn down
     *  independently. Previously hardcoded directly in
     *  nextgen-vector-store-stack.ts, inconsistent with every other stack's
     *  config-driven naming — moved here to match. */
    readonly collectionName: string;
    readonly collectionGroupName: string;
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
  };

  readonly dashboard: {
    readonly clusterName: string;
    readonly serviceName: string;
    readonly logGroupName: string;
    readonly logRetention: logs.RetentionDays;
    readonly taskCpu: number;
    readonly taskMemoryMiB: number;
    /** Port the Express app listens on inside the container — also the ALB target group's port. */
    readonly port: number;
    /** Index name used inside NextGenVectorStoreStack's collection for the dashboard's real
     *  (non-throwaway) seeded findings — distinct collection from Classic's, so reusing
     *  vectorStore.indexName's exact string here would be fine too, but this is named
     *  separately since the two collections' indexes are provisioned independently. */
    readonly nextGenIndexName: string;
    /** Total findings generated per "Seed Sample Data" run, split evenly
     *  between S3 and DynamoDB (see app/src/seed.ts's same S3_SHARE=0.5
     *  pattern) before being read back and indexed into both OpenSearch
     *  collections. At ~1s per Bedrock embedding call, this many findings
     *  takes a while — that's why /api/seed runs as a background job with
     *  a /api/seed/status polling endpoint, not a single long request. */
    readonly seedCount: number;
  };

  readonly bastion: {
    /** SSM-only bastion — no key pair, no SSH, no public IP. Exists solely so
     *  a laptop can SSM-port-forward into the private VPC to reach
     *  DashboardStack's internal ALB (ECS Exec can run commands but can't
     *  port-forward to a remote host — only a real EC2 SSM-managed instance
     *  can, which is the whole reason this stack exists). */
    readonly instanceName: string;
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

  nextGenVectorStore: {
    collectionName: "embed-compare-nextgen",
    collectionGroupName: "embed-compare-group",
    encryptionPolicyName: "embed-compare-encryption",
    networkPolicyName: "embed-compare-network",
    dataAccessPolicyName: "embed-compare-data-access"
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
    embeddingModel: "amazon.titan-embed-text-v2:0"
  },

  dashboard: {
    clusterName: "bedrock-opensearch-dashboard",
    serviceName: "eval-dashboard",
    logGroupName: "/bedrock-opensearch-replica/dashboard",
    logRetention: logs.RetentionDays.TWO_WEEKS,
    taskCpu: 512,
    taskMemoryMiB: 1024,
    port: 3000,
    nextGenIndexName: "replica-findings-kg",
    seedCount: 2000
  },

  bastion: {
    instanceName: "dashboard-ssm-bastion"
  }
};
