import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";
import { appConfig } from "./config";

/**
 * VPC + every endpoint the connector task (and ECS itself) needs to reach,
 * with zero internet access (no NAT, no IGW):
 *  - Bedrock runtime (interface) — embedding calls.
 *  - AOSS (its own dedicated resource type — AWS::OpenSearchServerless::VpcEndpoint,
 *    not a standard EC2 interface endpoint; see the constructor comment).
 *  - S3 + DynamoDB (gateway) — the two DataStack data sources.
 *  - ECR api + dkr, CloudWatch Logs (interface) — required for the Fargate
 *    task to pull its image and publish logs at all; not application-level
 *    dependencies, but the task cannot start/log without them in a VPC
 *    with no other internet path.
 */
export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly bedrockEndpoint: ec2.InterfaceVpcEndpoint;
  /** The AOSS VPC endpoint's ID (from Fn::GetAtt ...Id) — NOT an
   *  ec2.InterfaceVpcEndpoint. See the constructor comment on aossVpcEndpoint
   *  for why this is a different CloudFormation resource type entirely. */
  public readonly aossEndpointId: string;
  public readonly computeSg: ec2.SecurityGroup;
  /** Plain security-group IDs (not construct references) for the two shared
   *  endpoint SGs below — exposed so other stacks (e.g. DashboardStack) can
   *  add their own ingress rules onto these SGs via a standalone
   *  CfnSecurityGroupIngress resource in THEIR OWN stack, rather than
   *  NetworkStack importing a construct reference from a stack that itself
   *  depends on NetworkStack (would be a circular dependency — see
   *  DashboardStack's own comment on this for the full reasoning). */
  public readonly endpointSgId: string;
  public readonly aossEndpointSgId: string;
  /** NextGen collections resolve on a completely different domain
   *  (*.aoss.{region}.on.aws) than Classic (*.aoss.amazonaws.com) — the raw
   *  AWS::OpenSearchServerless::VpcEndpoint above only creates a private
   *  hosted zone for the Classic domain. NextGen requires a genuinely
   *  different, STANDARD interface VPC endpoint (service
   *  com.amazonaws.{region}.aoss-data) — confirmed via AWS's own docs after
   *  discovering the hard way that NextGen's hostname was resolving to
   *  public IPv6 addresses despite being correctly listed in the network
   *  policy (that policy only controls authorization, not DNS resolution —
   *  two separate layers). */
  public readonly aossNextGenEndpointId: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: appConfig.network.maxAzs,
      natGateways: appConfig.network.natGateways,
      subnetConfiguration: [
        {
          name: "isolated",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: appConfig.network.subnetCidrMask
        }
      ]
    });

    // Security group for the Fargate task — allows outbound HTTPS to the
    // VPC endpoints below (endpoints get their own SG allowing 443 inbound
    // from this one).
    this.computeSg = new ec2.SecurityGroup(this, "ComputeSg", {
      vpc: this.vpc,
      description: "Bedrock/OpenSearch connector task",
      allowAllOutbound: true
    });

    const endpointSg = new ec2.SecurityGroup(this, "EndpointSg", {
      vpc: this.vpc,
      description: "Interface VPC endpoints for Bedrock, ECR, and CloudWatch Logs (AOSS has its own dedicated SG below)",
      allowAllOutbound: false
    });
    endpointSg.addIngressRule(this.computeSg, ec2.Port.tcp(443), "HTTPS from compute task");
    this.endpointSgId = endpointSg.securityGroupId;

    // Bedrock runtime — required for embedding calls (bedrock-runtime, not
    // the "bedrock" control-plane service, which is a different endpoint).
    this.bedrockEndpoint = this.vpc.addInterfaceEndpoint("BedrockRuntimeEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [endpointSg],
      privateDnsEnabled: true
    });

    // OpenSearch Serverless VPC endpoint — CORRECTED from an earlier draft
    // of this file, which wrongly modeled this as a standard EC2 interface
    // endpoint (`ec2.addInterfaceEndpoint` / `AWS::EC2::VPCEndpoint`). AOSS
    // endpoints are NOT that resource type at all — verified directly
    // against pentesting-agentic-harness-infra's lib/knowledge-graph-stack.ts,
    // which provisions this as a raw `AWS::OpenSearchServerless::VpcEndpoint`
    // resource (same reasoning as why the collection itself is a raw
    // CfnResource: L2 construct support doesn't cover this). Using the wrong
    // resource type would have failed at deploy time, not just been
    // suboptimal — worth flagging since it went unnoticed in the first pass.
    const aossEndpointSg = new ec2.SecurityGroup(this, "AossEndpointSg", {
      vpc: this.vpc,
      description: "Security group for the AOSS VPC endpoint",
      allowAllOutbound: false
    });
    aossEndpointSg.addIngressRule(this.computeSg, ec2.Port.tcp(443), "Compute task to AOSS");
    this.aossEndpointSgId = aossEndpointSg.securityGroupId;

    const aossVpcEndpoint = new cdk.CfnResource(this, "AossVpcEndpoint", {
      type: "AWS::OpenSearchServerless::VpcEndpoint",
      properties: {
        Name: appConfig.network.aossVpcEndpointName,
        VpcId: this.vpc.vpcId,
        SubnetIds: this.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }).subnetIds,
        SecurityGroupIds: [aossEndpointSg.securityGroupId]
      }
    });
    // Reference's own code confirms this is GetAtt("Id"), not .ref —
    // verified at lib/knowledge-graph-stack.ts:312.
    this.aossEndpointId = aossVpcEndpoint.getAtt("Id").toString();

    // S3 and DynamoDB are the two data-source entry points added for
    // DataStack. With no NAT gateway in this VPC (deliberately — see the
    // class comment), a private-isolated subnet has NO route to either
    // service unless a gateway endpoint is added: these are free (no
    // hourly/per-GB interface-endpoint cost, unlike the two above) and are
    // the standard way to reach S3/DynamoDB from fully-isolated subnets.
    // Without these two lines, DataStack's bucket/table would be
    // unreachable from the connector task despite having IAM permission to
    // read them — a network-layer gap, not a permissions one.
    this.vpc.addGatewayEndpoint("S3GatewayEndpoint", {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [{ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }]
    });
    this.vpc.addGatewayEndpoint("DynamoDbGatewayEndpoint", {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
      subnets: [{ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }]
    });

    // DEFERRED along with ComputeStack in bin/app.ts: without these three,
    // the Fargate task itself cannot start in this NAT-less, IGW-less VPC —
    // this isn't about the connector's own AWS SDK calls (Bedrock/AOSS/S3/
    // DynamoDB, all covered above), it's what ECS needs just to launch the
    // task and receive its logs:
    //  - ecr.api + ecr.dkr: pulling the container image from ECR (the
    //    README's documented deploy path). The S3 gateway endpoint above is
    //    also required for this (ECR image layers are stored in S3), but is
    //    NOT sufficient by itself — ecr.api/ecr.dkr are still needed for the
    //    registry API calls themselves.
    //  - logs: the task definition's `ecs.LogDrivers.awsLogs()` driver
    //    (see ComputeStack) needs to reach CloudWatch Logs to publish
    //    anything — without this endpoint, the task would still run but
    //    every log line would fail to publish, silently, making the
    //    container's own console.log() output (the only feedback this demo
    //    produces) invisible.
    this.vpc.addInterfaceEndpoint("EcrApiEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.ECR,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [endpointSg]
    });
    this.vpc.addInterfaceEndpoint("EcrDkrEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [endpointSg]
    });
    this.vpc.addInterfaceEndpoint("CloudWatchLogsEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [endpointSg]
    });

    // Added for DashboardStack: ECS Exec (and the SSM port-forwarding session
    // used to reach the internal-only dashboard ALB from a laptop) both ride
    // over Systems Manager's own channel, which needs these three endpoints
    // to work with zero internet access — same reasoning as ECR/logs above,
    // this isn't optional once ECS Exec is enabled on any task in this VPC.
    this.vpc.addInterfaceEndpoint("SsmMessagesEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [endpointSg]
    });
    this.vpc.addInterfaceEndpoint("SsmEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.SSM,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [endpointSg]
    });
    this.vpc.addInterfaceEndpoint("Ec2MessagesEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [endpointSg]
    });

    // NextGen collections' private connectivity — see the aossNextGenEndpointId
    // class member comment above for why this is a completely separate
    // endpoint from AossVpcEndpoint, not optional/redundant with it. Not in
    // CDK's built-in InterfaceVpcEndpointAwsService enum yet (too new), so
    // constructed manually from the raw PrivateLink service name.
    const aossNextGenVpcEndpoint = this.vpc.addInterfaceEndpoint("AossNextGenEndpoint", {
      service: new ec2.InterfaceVpcEndpointService(`com.amazonaws.${cdk.Aws.REGION}.aoss-data`, 443),
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [endpointSg],
      privateDnsEnabled: true
    });
    this.aossNextGenEndpointId = aossNextGenVpcEndpoint.vpcEndpointId;
  }
}
