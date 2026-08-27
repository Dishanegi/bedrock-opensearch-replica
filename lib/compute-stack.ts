import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import { appConfig } from "./config";

export interface ComputeStackProps extends cdk.StackProps {
  readonly vpc: ec2.Vpc;
  readonly computeSg: ec2.SecurityGroup;
  readonly taskRole: iam.Role;
  readonly executionRole: iam.Role;
  /** From IamStack.connectorLogGroup — created there, not here; see the
   *  comment on IamStack for why (avoids a cross-stack IAM grant cycle). */
  readonly connectorLogGroup: logs.LogGroup;
  readonly opensearchEndpoint: string;
  readonly opensearchCollectionName: string;
  readonly opensearchIndexName: string;
  readonly documentsBucketName: string;
  readonly documentsPrefix: string;
  readonly documentsTableName: string;
}

/**
 * ECS cluster + a single Fargate task definition for the connector
 * container. Deliberately NOT a long-running Service and NOT wired to any
 * scheduled trigger — per the plan, this is meant to be invoked on demand
 * via `aws ecs run-task` to demonstrate the Bedrock<->OpenSearch connection,
 * not to run continuously like the reference platform's batch-runner tasks.
 */
export class ComputeStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly taskDefinition: ecs.FargateTaskDefinition;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);

    this.cluster = new ecs.Cluster(this, "Cluster", {
      vpc: props.vpc,
      clusterName: appConfig.compute.clusterName,
      containerInsights: true
    });

    this.taskDefinition = new ecs.FargateTaskDefinition(this, "ConnectorTaskDef", {
      cpu: appConfig.compute.taskCpu,
      memoryLimitMiB: appConfig.compute.taskMemoryMiB,
      taskRole: props.taskRole,
      executionRole: props.executionRole,
      // Matches the arm64 image ecs.ContainerImage.fromAsset() below builds
      // on Apple Silicon machines by default — without this, Fargate assumes
      // x86_64 and the task fails immediately with "exec format error".
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX
      }
    });

    this.taskDefinition.addContainer("connector", {
      // Built from app/ (see app/Dockerfile) via Docker on the machine
      // running `cdk deploy` — CDK builds the image and pushes it to a
      // CDK-managed (bootstrap) ECR repo automatically as part of asset
      // publishing, no manual ECR repo/push step needed.
      image: ecs.ContainerImage.fromAsset(path.join(__dirname, "..", "app")),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "connector", logGroup: props.connectorLogGroup }),
      environment: {
        OPENSEARCH_ENDPOINT: props.opensearchEndpoint,
        OPENSEARCH_COLLECTION_NAME: props.opensearchCollectionName,
        OPENSEARCH_INDEX_NAME: props.opensearchIndexName,
        EMBEDDING_MODEL: appConfig.compute.embeddingModel,
        EMBEDDING_DIMENSION: String(appConfig.vectorStore.embeddingDimension),
        AWS_REGION: cdk.Aws.REGION,
        DOCUMENTS_BUCKET_NAME: props.documentsBucketName,
        DOCUMENTS_PREFIX: props.documentsPrefix,
        DOCUMENTS_TABLE_NAME: props.documentsTableName
      }
    });
  }
}
