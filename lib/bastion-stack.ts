import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { appConfig } from "./config";

export interface BastionStackProps extends cdk.StackProps {
  readonly vpc: ec2.Vpc;
  /** NetworkStack's shared endpoint-VPC-endpoint security group ID (plain
   *  string, not a construct reference) — same pattern DashboardStack uses,
   *  for the same reason: avoids NetworkStack needing to depend on a stack
   *  that itself depends on NetworkStack. */
  readonly endpointSgId: string;
}

/**
 * A single t3.micro EC2 instance whose only job is to be a real, persistent
 * SSM-managed instance — no SSH key pair, no public IP, nothing else
 * installed. Exists because ECS Exec (used by DashboardStack) can run
 * commands inside a container but cannot port-forward to a remote host —
 * only a genuinely SSM-registered EC2 instance supports the
 * AWS-StartPortForwardingSessionToRemoteHost session document, which is
 * what's needed to reach DashboardStack's internal-only ALB from a laptop.
 * Discovered the hard way this session: `aws ssm start-session --target
 * ecs:...` fails with TargetNotConnected even when `aws ecs execute-command`
 * against the exact same task succeeds — they're genuinely different
 * mechanisms, not a config bug.
 *
 * No NAT/IGW needed — SSM Agent (built into Amazon Linux 2023) reaches AWS
 * entirely through the ssm/ssmmessages/ec2messages interface VPC endpoints
 * already added to NetworkStack for DashboardStack's own ECS Exec support.
 * The ALB itself needs no new security-group wiring: its existing rule
 * already allows the whole VPC CIDR on port 80 (see DashboardStack), which
 * this instance satisfies automatically by being in the same VPC.
 */
export class BastionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: BastionStackProps) {
    super(scope, id, props);

    const role = new iam.Role(this, "BastionRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      description: "SSM-only bastion - no permissions beyond what SSM itself needs",
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")]
    });

    const sg = new ec2.SecurityGroup(this, "BastionSg", {
      vpc: props.vpc,
      description: "SSM bastion - no inbound rules at all, outbound only",
      allowAllOutbound: true
    });

    // Standalone ingress-rule resource targeting NetworkStack's existing
    // shared endpoint SG by ID — same non-circular pattern as
    // DashboardStack's TaskToEndpointSg.
    new ec2.CfnSecurityGroupIngress(this, "BastionToEndpointSg", {
      groupId: props.endpointSgId,
      sourceSecurityGroupId: sg.securityGroupId,
      ipProtocol: "tcp",
      fromPort: 443,
      toPort: 443,
      description: "Bastion to SSM VPC endpoints"
    });

    new ec2.Instance(this, "Bastion", {
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      role,
      securityGroup: sg,
      // No key pair — SSH is never used, SSM Session Manager is the only access path.
    });

    cdk.Tags.of(this).add("Name", appConfig.bastion.instanceName);
  }
}
