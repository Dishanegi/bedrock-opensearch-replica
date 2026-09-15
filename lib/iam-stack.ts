import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import { appConfig } from "./config";

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
 *
 * The connector's CloudWatch log group is also created here, not in
 * ComputeStack — same reasoning as the roles above. `ecs.LogDrivers.awsLogs()`
 * automatically grants the *execution role* logs:CreateLogStream/PutLogEvents
 * on the log group the moment the container is added to the task definition.
 * If the log group lived in ComputeStack, that grant would add an IAM policy
 * statement to `executionRole` (an IamStack resource) referencing a
 * ComputeStack token — requiring IamStack to depend on ComputeStack. Since
 * ComputeStack already transitively depends on IamStack (it needs
 * taskRole/executionRole, and depends on VectorStoreStack, which depends on
 * NetworkStack, which depends on IamStack), that reverse edge is a genuine
 * cycle CDK refuses to resolve. Creating the log group here instead keeps the
 * grant same-stack, so no cross-stack reference — and therefore no cycle —
 * is ever created.
 */
export class IamStack extends cdk.Stack {
  public readonly taskRole: iam.Role;
  public readonly executionRole: iam.Role;
  public readonly connectorLogGroup: logs.LogGroup;
  /** DashboardStack's log group — lives here for the exact same reason
   *  connectorLogGroup does (see class comment): DashboardStack reuses this
   *  stack's executionRole, so creating the log group in DashboardStack
   *  instead would force IamStack to depend on DashboardStack for the
   *  auto-granted logs:CreateLogStream/PutLogEvents permission, creating the
   *  same cycle already documented above. */
  public readonly dashboardLogGroup: logs.LogGroup;

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

    // Automatic Semantic Enrichment (ASE) requires provisioning the index
    // itself through the opensearchserverless control-plane API's own
    // Create/Get/Update/DeleteIndex operations (aws opensearchserverless
    // create-index, or CreateIndexCommand via @aws-sdk/client-opensearchserverless)
    // rather than a generic OpenSearch data-plane PUT — confirmed against
    // AWS's ASE documentation IAM example, which lists exactly these five
    // actions. aoss:CreateMLResource covers the service-managed ML model ASE
    // provisions per index; the *Index actions cover the schema operation
    // that actually turns semantic_enrichment on. Required here on the
    // identity policy in addition to being allowed by the AOSS data-access
    // policy itself (VectorStoreStack/NextGenVectorStoreStack's
    // DataAccessPolicy already wildcards aoss:* on collection/index/model
    // there) — AOSS enforces both layers independently, so granting only one
    // is not enough.
    this.taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "AossSemanticEnrichment",
        actions: ["aoss:CreateMLResource", "aoss:CreateIndex", "aoss:GetIndex", "aoss:UpdateIndex", "aoss:DeleteIndex"],
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

    this.connectorLogGroup = new logs.LogGroup(this, "ConnectorLogGroup", {
      logGroupName: appConfig.compute.logGroupName,
      retention: appConfig.compute.logRetention,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    this.dashboardLogGroup = new logs.LogGroup(this, "DashboardLogGroup", {
      logGroupName: appConfig.dashboard.logGroupName,
      retention: appConfig.dashboard.logRetention,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });
  }
}
