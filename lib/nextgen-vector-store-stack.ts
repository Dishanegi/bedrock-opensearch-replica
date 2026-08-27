import * as cdk from "aws-cdk-lib";
import * as opensearchserverless from "aws-cdk-lib/aws-opensearchserverless";
import { Construct } from "constructs";
import { appConfig } from "./config";

export interface NextGenVectorStoreStackProps extends cdk.StackProps {
  /** IAM principal (e.g. your own IAM user ARN) to grant data-plane access
   *  to, for running the embedding-model comparison directly from a laptop
   *  rather than through ComputeStack's Fargate task. */
  readonly comparisonPrincipalArn: string;
  /** Extra IAM principal ARNs (beyond comparisonPrincipalArn) granted the same
   *  collection/index data-access permissions — e.g. DashboardStack's task role,
   *  so the dashboard's Fargate service can query this collection from inside
   *  the VPC. Mirrors VectorStoreStack's additionalDataAccessPrincipals. */
  readonly additionalPrincipalArns?: string[];
  /** NetworkStack.aossNextGenEndpointId — the STANDARD interface VPC endpoint
   *  (service com.amazonaws.{region}.aoss-data) for NextGen collections'
   *  private connectivity. NOT the same resource as VectorStoreStack's raw
   *  AWS::OpenSearchServerless::VpcEndpoint (that one only creates a private
   *  hosted zone for Classic's *.aoss.amazonaws.com domain — using its ID
   *  here silently fails to resolve privately at all, discovered the hard
   *  way: NextGen's hostname kept resolving to public IPv6 addresses even
   *  though this exact prop, populated with the WRONG endpoint's ID, was
   *  accepted without error by the network-policy API). Optional: if
   *  omitted, the collection stays public-access-only. */
  readonly aossNextGenEndpointId?: string;
}

/**
 * Standalone, throwaway stack for a one-off comparison of embedding models
 * (Titan v2 vs Cohere v4) on a NextGen OpenSearch Serverless collection —
 * deliberately kept separate from VectorStoreStack (the Classic collection
 * the rest of this project uses) so it can be torn down independently once
 * the comparison is done, with zero risk to the working Classic setup.
 *
 * Network access is public (IAM-gated via the data access policy below,
 * not open to the world) rather than VPC-endpoint-only, since this is meant
 * to be queried directly from a laptop for a quick side-by-side test — not
 * wired into ComputeStack/NetworkStack at all.
 *
 * Note: the `Engine` property (hnsw/faiss) that Classic collections support
 * on their knn_vector index mapping is NOT configurable on NextGen
 * collections — the comparison script must omit it when creating indexes
 * here.
 */
export class NextGenVectorStoreStack extends cdk.Stack {
  public readonly collectionEndpoint: string;
  public readonly collectionName: string;

  constructor(scope: Construct, id: string, props: NextGenVectorStoreStackProps) {
    super(scope, id, props);

    this.collectionName = appConfig.nextGenVectorStore.collectionName;
    const collectionGroupName = appConfig.nextGenVectorStore.collectionGroupName;

    const collectionGroup = new opensearchserverless.CfnCollectionGroup(this, "CollectionGroup", {
      name: collectionGroupName,
      generation: "NEXTGEN",
      // AOSS now rejects DISABLED here — "StandbyReplicas cannot be set to
      // DISABLED for NEXTGEN collection groups" (a live API constraint that
      // wasn't enforced when this stack first deployed successfully earlier
      // in this project's history; not a regression in this code).
      standbyReplicas: "ENABLED",
      description: "Throwaway NextGen collection group for the Titan v2 vs Cohere v4 embedding comparison"
    });

    const encryptionPolicy = new opensearchserverless.CfnSecurityPolicy(this, "EncryptionPolicy", {
      name: appConfig.nextGenVectorStore.encryptionPolicyName,
      type: "encryption",
      policy: JSON.stringify({
        Rules: [{ ResourceType: "collection", Resource: [`collection/${this.collectionName}`] }],
        AWSOwnedKey: true
      })
    });

    // Two separate rule objects for the same collection resource: one keeps
    // the existing public-access path (laptop testing), the other adds
    // SourceVPCEs so DashboardStack's Fargate task (inside NetworkStack's
    // VPC) can also reach it. AllowFromPublic/SourceVPCEs are mutually
    // exclusive WITHIN one rule (see VectorStoreStack's own comment on this),
    // but nothing in AOSS's docs suggests two separate rules for the same
    // resource is invalid — this is the one thing in this stack genuinely
    // unverified until the first `cdk deploy` after this change; if AOSS
    // rejects it, drop the public rule and keep VPC-only (the dashboard
    // becomes the primary way to reach this collection anyway).
    const networkPolicy = new opensearchserverless.CfnSecurityPolicy(this, "NetworkPolicy", {
      name: appConfig.nextGenVectorStore.networkPolicyName,
      type: "network",
      policy: JSON.stringify([
        {
          Rules: [
            { ResourceType: "collection", Resource: [`collection/${this.collectionName}`] },
            { ResourceType: "dashboard", Resource: [`collection/${this.collectionName}`] }
          ],
          AllowFromPublic: true
        },
        ...(props.aossNextGenEndpointId
          ? [
              {
                Rules: [
                  { ResourceType: "collection", Resource: [`collection/${this.collectionName}`] },
                  { ResourceType: "dashboard", Resource: [`collection/${this.collectionName}`] }
                ],
                AllowFromPublic: false,
                SourceVPCEs: [props.aossNextGenEndpointId]
              }
            ]
          : [])
      ])
    });

    const collection = new opensearchserverless.CfnCollection(this, "Collection", {
      name: this.collectionName,
      type: "VECTORSEARCH",
      collectionGroupName: collectionGroupName
    });
    collection.addDependency(encryptionPolicy);
    collection.addDependency(networkPolicy);
    collection.addDependency(collectionGroup);

    new opensearchserverless.CfnAccessPolicy(this, "DataAccessPolicy", {
      name: appConfig.nextGenVectorStore.dataAccessPolicyName,
      type: "data",
      policy: JSON.stringify([
        {
          Rules: [
            { ResourceType: "collection", Resource: [`collection/${this.collectionName}`], Permission: ["aoss:*"] },
            { ResourceType: "index", Resource: [`index/${this.collectionName}/*`], Permission: ["aoss:*"] }
          ],
          Principal: [props.comparisonPrincipalArn, ...(props.additionalPrincipalArns ?? [])]
        }
      ])
    });

    this.collectionEndpoint = collection.attrCollectionEndpoint;

    new cdk.CfnOutput(this, "CollectionEndpointOutput", {
      description: "NextGen collection endpoint for the embedding comparison script",
      value: this.collectionEndpoint
    });
  }
}
