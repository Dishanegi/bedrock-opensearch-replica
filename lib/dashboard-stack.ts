import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import { appConfig } from "./config";

export interface DashboardStackProps extends cdk.StackProps {
  readonly vpc: ec2.Vpc;
  readonly taskRole: iam.Role;
  readonly executionRole: iam.Role;
  readonly dashboardLogGroup: logs.LogGroup;
  readonly classicOpensearchEndpoint: string;
  readonly classicIndexName: string;
  readonly nextGenOpensearchEndpoint: string;
  readonly nextGenIndexName: string;
  /** DataStack's bucket/table — the dashboard's seed job writes generated
   *  findings here (real S3 + DynamoDB, not just in-memory) and reads them
   *  back before indexing into OpenSearch, same round-trip app/src/index.ts's
   *  real ingest pipeline does. Needs grantWrite/grantWriteData in addition
   *  to the grantRead/grantReadData already given to this same task role for
   *  ComputeStack's connector — see bin/app.ts. */
  readonly documentsBucketName: string;
  readonly documentsPrefix: string;
  readonly documentsTableName: string;
  /** NetworkStack's shared VPC-endpoint security groups (plain IDs, not
   *  construct references — see the comment on these in NetworkStack for
   *  why: avoids a circular dependency, since NetworkStack must deploy
   *  before this stack). This stack's own taskSg gets added to both via a
   *  standalone CfnSecurityGroupIngress resource below, so the dashboard's
   *  Bedrock/OpenSearch calls (previously only ComputeStack's SG was
   *  authorized) actually work. */
  readonly endpointSgId: string;
  readonly aossEndpointSgId: string;
}

/**
 * Side-by-side Classic vs NextGen OpenSearch evaluation dashboard —
 * a persistent ECS Fargate service (not a one-off task like ComputeStack,
 * since this needs to stay up to serve a browser), fronted by an INTERNAL
 * Application Load Balancer. No public IP anywhere in this stack: the ALB
 * is internetFacing:false and sits in NetworkStack's private-isolated
 * subnets, same as the service itself — reachable only from inside the VPC
 * (or anything peered/VPNed into it), never the public internet.
 *
 * HTTP only (no TLS) — deliberate, temporary tradeoff: the VPC boundary
 * itself is the security control here, matching this project's existing
 * "structure first, harden later" pattern (see app/src/embed.ts's retry/
 * backoff TODO for the same philosophy elsewhere in this repo). Adding TLS
 * would need a real domain + ACM certificate (public or a private CA) —
 * concrete follow-up if this ever needs to leave the private network.
 *
 * Reuses IamStack's taskRole/executionRole directly (already has
 * bedrock:InvokeModel + aoss:APIAccessAll wildcards) rather than minting new
 * roles — see the dashboardLogGroup comment in lib/iam-stack.ts for why its
 * log group had to live there instead of here (same circular-dependency
 * reasoning as ComputeStack's connectorLogGroup).
 */
export class DashboardStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DashboardStackProps) {
    super(scope, id, props);

    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc: props.vpc,
      clusterName: appConfig.dashboard.clusterName
    });

    const albSg = new ec2.SecurityGroup(this, "AlbSg", {
      vpc: props.vpc,
      description: "Internal ALB for the OpenSearch evaluation dashboard",
      allowAllOutbound: true
    });
    albSg.addIngressRule(ec2.Peer.ipv4(props.vpc.vpcCidrBlock), ec2.Port.tcp(80), "HTTP from within the VPC only");

    const taskSg = new ec2.SecurityGroup(this, "TaskSg", {
      vpc: props.vpc,
      description: "Dashboard Fargate task",
      allowAllOutbound: true
    });
    taskSg.addIngressRule(albSg, ec2.Port.tcp(appConfig.dashboard.port), "From the internal ALB only");

    // Standalone ingress-rule resources (not taskSg.addIngressRule, which
    // would try to attach the rule to taskSg itself) targeting NetworkStack's
    // existing shared endpoint SGs by ID — these are separate
    // AWS::EC2::SecurityGroupIngress resources living in THIS stack, so
    // NetworkStack never needs to know DashboardStack exists.
    new ec2.CfnSecurityGroupIngress(this, "TaskToEndpointSg", {
      groupId: props.endpointSgId,
      sourceSecurityGroupId: taskSg.securityGroupId,
      ipProtocol: "tcp",
      fromPort: 443,
      toPort: 443,
      description: "Dashboard task to Bedrock/ECR/Logs/SSM VPC endpoints"
    });
    new ec2.CfnSecurityGroupIngress(this, "TaskToAossEndpointSg", {
      groupId: props.aossEndpointSgId,
      sourceSecurityGroupId: taskSg.securityGroupId,
      ipProtocol: "tcp",
      fromPort: 443,
      toPort: 443,
      description: "Dashboard task to AOSS VPC endpoint"
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, "TaskDef", {
      cpu: appConfig.dashboard.taskCpu,
      memoryLimitMiB: appConfig.dashboard.taskMemoryMiB,
      taskRole: props.taskRole,
      executionRole: props.executionRole,
      // Matches the arm64 image fromAsset() builds on this Apple Silicon dev
      // machine by default — same fix ComputeStack needed after hitting
      // "exec format error" on a default x86_64 Fargate assumption.
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX
      }
    });

    const container = taskDefinition.addContainer("dashboard", {
      image: ecs.ContainerImage.fromAsset(path.join(__dirname, "..", "dashboard")),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "dashboard", logGroup: props.dashboardLogGroup }),
      environment: {
        PORT: String(appConfig.dashboard.port),
        AWS_REGION: cdk.Aws.REGION,
        EMBEDDING_DIMENSION: String(appConfig.vectorStore.embeddingDimension),
        CLASSIC_OPENSEARCH_ENDPOINT: props.classicOpensearchEndpoint,
        CLASSIC_INDEX_NAME: props.classicIndexName,
        NEXTGEN_OPENSEARCH_ENDPOINT: props.nextGenOpensearchEndpoint,
        NEXTGEN_INDEX_NAME: props.nextGenIndexName,
        DOCUMENTS_BUCKET_NAME: props.documentsBucketName,
        DOCUMENTS_PREFIX: props.documentsPrefix,
        DOCUMENTS_TABLE_NAME: props.documentsTableName,
        SEED_COUNT: String(appConfig.dashboard.seedCount)
      }
    });
    container.addPortMappings({ containerPort: appConfig.dashboard.port });

    const service = new ecs.FargateService(this, "Service", {
      cluster,
      taskDefinition,
      serviceName: appConfig.dashboard.serviceName,
      desiredCount: 1,
      securityGroups: [taskSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      // Fails fast (instead of CDK's default up-to-3-hour wait) if the task
      // can't start — same slow-failure pain already hit more than once this
      // session, worth avoiding here.
      circuitBreaker: { rollback: true }
      // NOT enableExecuteCommand — tried this for browser access to the
      // internal ALB (via SSM port-forwarding to the ECS task directly) and
      // it doesn't work: `aws ecs execute-command` (shell into the container)
      // succeeds, but `aws ssm start-session --target ecs:...` with the
      // AWS-StartPortForwardingSessionToRemoteHost document fails with
      // TargetNotConnected every time — ECS Exec activates a per-invocation
      // session, it never registers the task as a persistent SSM managed
      // instance, which port-forwarding to a remote host requires. See
      // BastionStack for the actual fix (a real EC2 instance, which does
      // register persistently).
    });

    const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      vpc: props.vpc,
      internetFacing: false,
      securityGroup: albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED }
    });

    const listener = alb.addListener("Listener", { port: 80, open: false });
    listener.addTargets("DashboardTarget", {
      port: appConfig.dashboard.port,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      healthCheck: { path: "/api/health" }
    });

    new cdk.CfnOutput(this, "DashboardUrl", {
      description: "Internal ALB DNS name - reachable only from inside the VPC or anything peered/VPNed into it",
      value: `http://${alb.loadBalancerDnsName}`
    });
  }
}
