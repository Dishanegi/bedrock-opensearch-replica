#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { appConfig } from "../lib/config";
import { ComputeStack } from "../lib/compute-stack";
import { DataStack } from "../lib/data-stack";
import { IamStack } from "../lib/iam-stack";
import { NetworkStack } from "../lib/network-stack";
import { VectorStoreStack } from "../lib/vector-store-stack";

const app = new cdk.App();

const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION };

// Order matters here and is deliberate — see the comment at the top of
// IamStack for why IAM is created first, before the two stacks that
// otherwise would need each other's outputs.
const iamStack = new IamStack(app, "IamStack", { env });

const networkStack = new NetworkStack(app, "NetworkStack", { env });
networkStack.addDependency(iamStack);

const vectorStoreStack = new VectorStoreStack(app, "VectorStoreStack", {
  env,
  aossEndpointId: networkStack.aossEndpointId,
  taskRole: iamStack.taskRole
});
vectorStoreStack.addDependency(networkStack);

// Standalone — no dependency on the other stacks. Grants to the task role
// happen below, after both this stack and iamStack exist; see the comment
// in lib/data-stack.ts for why this is least-privilege (bucket/table-scoped)
// rather than the wildcard-resource pattern used for Bedrock/AOSS.
const dataStack = new DataStack(app, "DataStack", { env });

dataStack.documentsBucket.grantRead(iamStack.taskRole);
dataStack.documentsTable.grantReadData(iamStack.taskRole);

const computeStack = new ComputeStack(app, "ComputeStack", {
  env,
  vpc: networkStack.vpc,
  computeSg: networkStack.computeSg,
  taskRole: iamStack.taskRole,
  executionRole: iamStack.executionRole,
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
