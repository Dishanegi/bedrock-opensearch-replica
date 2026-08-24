import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

/**
 * Created first, deliberately separate from VectorStoreStack and ComputeStack,
 * to avoid a circular dependency: VectorStoreStack's data-access policy needs
 * this role's ARN, and ComputeStack needs the role to attach to its task
 * definition — if the role lived inside ComputeStack, VectorStoreStack
 * couldn't reference it without ComputeStack existing first, which itself
 * needs VectorStoreStack's collection endpoint. Splitting IAM out breaks the
 * cycle. This mirrors pentesting-agentic-harness-infra's own IamStack, which
 * is deployed before VpcStack/DataStack for the same reason.
 *
 * Permissions are wildcard-scoped (not tied to a specific collection ARN),
 * matching the reference lib/iam-stack.ts's AossAccess statement — AOSS
 * control-plane/data-plane actions generally aren't scoped to a single
 * collection ID in practice in the reference codebase either.
 */
export class IamStack extends cdk.Stack {
  public readonly taskRole: iam.Role;
  public readonly executionRole: iam.Role;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.taskRole = new iam.Role(this, "ConnectorTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: "Fargate task role for the Bedrock<->OpenSearch connector"
    });

    // Bedrock: embedding calls only. Matches kg.ts's usage — InvokeModel on
    // the foundation-model namespace, no model-specific ARN restriction
    // (same wildcard scope as the reference codebase's BedrockEmbeddings sid).
    this.taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "BedrockEmbeddings",
        actions: ["bedrock:InvokeModel"],
        resources: [`arn:aws:bedrock:${cdk.Aws.REGION}::foundation-model/*`]
      })
    );

    // AOSS: data-plane + dashboards access. Same two actions, same
    // collection/* wildcard resource pattern as lib/iam-stack.ts's
    // AossAccess statement in the reference codebase.
    this.taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "AossAccess",
        actions: ["aoss:APIAccessAll", "aoss:DashboardsAccessAll"],
        resources: [`arn:aws:aoss:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:collection/*`]
      })
    );

    // Standard ECS execution role — pull the image, write logs. Nothing
    // application-specific here.
    this.executionRole = new iam.Role(this, "ConnectorExecutionRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonECSTaskExecutionRolePolicy")
      ]
    });
  }
}
