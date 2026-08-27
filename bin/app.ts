#!/usr/bin/env node
import { execFileSync } from "child_process";
import * as cdk from "aws-cdk-lib";
import { appConfig } from "../lib/config";
import { BastionStack } from "../lib/bastion-stack";
import { ComputeStack } from "../lib/compute-stack";
import { DashboardStack } from "../lib/dashboard-stack";
import { DataStack } from "../lib/data-stack";
import { IamStack } from "../lib/iam-stack";
import { NetworkStack } from "../lib/network-stack";
import { NextGenVectorStoreStack } from "../lib/nextgen-vector-store-stack";
import { VectorStoreStack } from "../lib/vector-store-stack";

const app = new cdk.App();

const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION };

/**
 * Resolves the ARN of whoever is actually running `cdk synth`/`cdk deploy`
 * right now, via the same `aws sts get-caller-identity` lookup previously
 * done by hand — replaces a hardcoded ARN for one specific developer that
 * had no business being checked into source control. Falls back to
 * COMPARISON_PRINCIPAL_ARN (still takes priority if set) or undefined (not
 * a hardcoded ARN) if STS can't be reached — e.g. `cdk synth` run with no
 * AWS credentials configured, just to inspect the template offline.
 */
function resolveCurrentCallerArn(): string | undefined {
  if (process.env.COMPARISON_PRINCIPAL_ARN) return process.env.COMPARISON_PRINCIPAL_ARN;
  try {
    return execFileSync("aws", ["sts", "get-caller-identity", "--query", "Arn", "--output", "text"], {
      encoding: "utf-8"
    }).trim();
  } catch {
    return undefined;
  }
}

// Order matters here and is deliberate — see the comment at the top of
// IamStack for why IAM is created first, before the two stacks that
// otherwise would need each other's outputs.
const iamStack = new IamStack(app, "IamStack", { env });

const networkStack = new NetworkStack(app, "NetworkStack", { env });
networkStack.addDependency(iamStack);

// LOCAL_TEST_PRINCIPAL_ARN: TEMPORARY testing-only mechanism — set this env
// var to your own IAM user/role ARN to grant it the same AOSS data-access
// permissions as the task role, so ensureIndex()/indexDocument()/knnSearch()
// can be exercised from a laptop before ComputeStack/Fargate is deployed.
// Unset it and redeploy VectorStoreStack to revert to task-role-only access.
//
// LOCAL_TEST_ALLOW_PUBLIC_AOSS: TEMPORARY testing-only mechanism — the
// data-access principal above only grants IAM authorization; AOSS's network
// policy is a separate layer that otherwise restricts the collection to the
// VPC endpoint only, blocking a laptop's connection before IAM is ever
// checked. Set to "true" to allow public network access (still gated by the
// data-access policy's principals). Unset and redeploy VectorStoreStack to
// revert to VPC-endpoint-only access.
const vectorStoreStack = new VectorStoreStack(app, "VectorStoreStack", {
  env,
  aossEndpointId: networkStack.aossEndpointId,
  taskRole: iamStack.taskRole,
  additionalDataAccessPrincipals: process.env.LOCAL_TEST_PRINCIPAL_ARN
    ? [process.env.LOCAL_TEST_PRINCIPAL_ARN]
    : [],
  allowPublicNetworkAccess: process.env.LOCAL_TEST_ALLOW_PUBLIC_AOSS === "true"
});
vectorStoreStack.addDependency(networkStack);

// Standalone — no dependency on the other stacks. Grants to the task role
// happen below, after both this stack and iamStack exist; see the comment
// in lib/data-stack.ts for why this is least-privilege (bucket/table-scoped)
// rather than the wildcard-resource pattern used for Bedrock/AOSS.
const dataStack = new DataStack(app, "DataStack", { env });

dataStack.documentsBucket.grantRead(iamStack.taskRole);
dataStack.documentsTable.grantReadData(iamStack.taskRole);
// Write access for DashboardStack's seed job, which writes generated
// findings to S3/DynamoDB before reading them back (see dashboard/src/seed.ts) —
// same task role as ComputeStack's connector (read-only above), now also
// needs write for this second use case.
dataStack.documentsBucket.grantWrite(iamStack.taskRole);
dataStack.documentsTable.grantWriteData(iamStack.taskRole);

const computeStack = new ComputeStack(app, "ComputeStack", {
  env,
  vpc: networkStack.vpc,
  computeSg: networkStack.computeSg,
  taskRole: iamStack.taskRole,
  executionRole: iamStack.executionRole,
  connectorLogGroup: iamStack.connectorLogGroup,
  opensearchEndpoint: vectorStoreStack.collectionEndpoint,
  opensearchCollectionName: vectorStoreStack.collectionName,
  // Index name is app-runtime config, not a CDK stack output (CDK only
  // creates the collection; the app itself creates the index inside it via
  // ensureIndex() — see app/src/opensearch.ts) — sourced directly from
  // appConfig rather than threaded through VectorStoreStack as a construct
  // property it doesn't actually own.
  opensearchIndexName: appConfig.vectorStore.indexName,
  documentsBucketName: dataStack.documentsBucket.bucketName,
  documentsPrefix: dataStack.documentsPrefix,
  documentsTableName: dataStack.documentsTable.tableName
});
computeStack.addDependency(vectorStoreStack);
computeStack.addDependency(dataStack);

// Originally a fully standalone, throwaway stack for a one-off Titan v2 vs
// Cohere v4 embedding comparison. Now also reachable from inside
// NetworkStack's VPC so DashboardStack's Fargate task can query it too —
// via aossNextGenEndpointId, NOT aossEndpointId. NextGen collections resolve
// on a different domain than Classic and need their own standard interface
// VPC endpoint (see the aossNextGenEndpointId comment in network-stack.ts) —
// using the Classic-style endpoint ID here compiles and deploys without
// error but silently fails to resolve privately (found out the hard way).
// COMPARISON_PRINCIPAL_ARN, if set, takes priority; otherwise resolved
// dynamically to whoever is actually running this deploy right now (via
// `aws sts get-caller-identity`) — not a hardcoded ARN for one specific
// developer, which had no business being checked into source control.
const comparisonPrincipalArn = resolveCurrentCallerArn();
if (!comparisonPrincipalArn) {
  throw new Error(
    "Could not resolve a principal ARN for NextGenVectorStoreStack's data-access policy. " +
      "Set COMPARISON_PRINCIPAL_ARN, or make sure `aws sts get-caller-identity` works " +
      "(valid AWS credentials configured)."
  );
}
const nextGenVectorStoreStack = new NextGenVectorStoreStack(app, "NextGenVectorStoreStack", {
  env,
  comparisonPrincipalArn,
  additionalPrincipalArns: [iamStack.taskRole.roleArn],
  aossNextGenEndpointId: networkStack.aossNextGenEndpointId
});
nextGenVectorStoreStack.addDependency(networkStack);

// Side-by-side Classic vs NextGen evaluation dashboard — see lib/dashboard-stack.ts.
const dashboardStack = new DashboardStack(app, "DashboardStack", {
  env,
  vpc: networkStack.vpc,
  taskRole: iamStack.taskRole,
  executionRole: iamStack.executionRole,
  dashboardLogGroup: iamStack.dashboardLogGroup,
  endpointSgId: networkStack.endpointSgId,
  aossEndpointSgId: networkStack.aossEndpointSgId,
  classicOpensearchEndpoint: vectorStoreStack.collectionEndpoint,
  classicIndexName: appConfig.vectorStore.indexName,
  nextGenOpensearchEndpoint: nextGenVectorStoreStack.collectionEndpoint,
  nextGenIndexName: appConfig.dashboard.nextGenIndexName,
  documentsBucketName: dataStack.documentsBucket.bucketName,
  documentsPrefix: dataStack.documentsPrefix,
  documentsTableName: dataStack.documentsTable.tableName
});
dashboardStack.addDependency(vectorStoreStack);
dashboardStack.addDependency(nextGenVectorStoreStack);
dashboardStack.addDependency(dataStack);

// SSM-only bastion — see lib/bastion-stack.ts for why this exists (ECS Exec
// can run commands but can't port-forward to a remote host; only a real
// EC2 SSM-managed instance can, which is needed to reach DashboardStack's
// internal ALB from a laptop).
const bastionStack = new BastionStack(app, "BastionStack", {
  env,
  vpc: networkStack.vpc,
  endpointSgId: networkStack.endpointSgId
});
bastionStack.addDependency(networkStack);
