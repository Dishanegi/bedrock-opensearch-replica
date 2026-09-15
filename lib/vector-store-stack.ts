import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import { Construct } from "constructs";
import { appConfig } from "./config";

export interface VectorStoreStackProps extends cdk.StackProps {
  /** From NetworkStack.aossEndpointId — the AWS::OpenSearchServerless::VpcEndpoint's
   *  GetAtt("Id"), not an ec2.InterfaceVpcEndpoint. */
  readonly aossEndpointId: string;
  readonly taskRole: iam.Role;
  /**
   * Extra IAM principal ARNs (beyond the task role) granted the same
   * collection/index data-access permissions. TEMPORARY, testing-only
   * mechanism — e.g. adding your own IAM user so ensureIndex()/indexDocument()
   * can be run from a laptop before ComputeStack/Fargate exists. Sourced from
   * an env var in bin/app.ts rather than hardcoded here, specifically so no
   * personal identity ends up committed — unset the env var and redeploy to
   * revert to task-role-only access.
   */
  readonly additionalDataAccessPrincipals?: string[];
  /**
   * TEMPORARY, testing-only: when true, the network policy allows access
   * from the public internet (still gated by the data-access policy's IAM
   * principals underneath) instead of restricting the collection to the
   * VPC endpoint only. Needed because AOSS's network policy is a separate
   * layer from IAM — being listed in the data-access policy is not enough
   * to reach the collection from outside the VPC at all. Sourced from an
   * env var in bin/app.ts; unset it and redeploy to revert to
   * VPC-endpoint-only access, matching the collection's normal design.
   */
  readonly allowPublicNetworkAccess?: boolean;
}

/**
 * OpenSearch Serverless (AOSS) collection + its three required policies.
 *
 * Mirrors pentesting-agentic-harness-infra/lib/knowledge-graph-stack.ts:
 * a single VECTORSEARCH-type collection, provisioned as a raw CfnResource
 * (the L2 construct support for AOSS was insufficient when that reference
 * stack was written, and this replica follows the same proven pattern
 * rather than assuming L2 support has since improved).
 */
export class VectorStoreStack extends cdk.Stack {
  public readonly collectionName = appConfig.vectorStore.collectionName;
  public readonly collectionEndpoint: string;
  /** Collection ID (distinct from collectionName) — required by the
   *  opensearchserverless control-plane API's CreateIndex/GetIndex/
   *  DeleteIndex operations (id, not name). Needed for ASE index
   *  provisioning specifically; the generic OpenSearch data-plane client
   *  used for the dense knn_vector index only ever needed the endpoint. */
  public readonly collectionId: string;

  constructor(scope: Construct, id: string, props: VectorStoreStackProps) {
    super(scope, id, props);

    // AOSS requires a customer-managed KMS key for its encryption policy —
    // it cannot use the AWS-managed default key for collections created
    // this way. AOSS also can't be granted key access via a normal key
    // policy statement (same gotcha documented in the reference stack); a
    // KMS Grant is used instead of embedding AOSS in the key policy itself.
    const key = new kms.Key(this, "CollectionKey", {
      description: "Encryption key for the replica AOSS collection",
      enableKeyRotation: true,
      // kms.Key defaults to RemovalPolicy.RETAIN (a CDK safety default, since
      // deleting a key makes anything it encrypted permanently unreadable).
      // For this demo/replica, the key exists solely to encrypt this one
      // disposable collection, which is destroyed in the same stack — so
      // retaining the key after the collection it protects is already gone
      // would just leave an orphaned, silently-billed resource behind.
      // DESTROY here means "gone on cdk destroy," matching every other
      // resource in this project. Note this only *schedules* deletion — AWS
      // enforces a mandatory 7-30 day waiting window on actual KMS key
      // deletion regardless of this setting; it won't vanish instantly.
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    const encryptionPolicy = new cdk.CfnResource(this, "EncryptionPolicy", {
      type: "AWS::OpenSearchServerless::SecurityPolicy",
      properties: {
        Name: appConfig.vectorStore.encryptionPolicyName,
        Type: "encryption",
        Policy: JSON.stringify({
          Rules: [{ ResourceType: "collection", Resource: [`collection/${this.collectionName}`] }],
          AWSOwnedKey: false,
          KmsARN: key.keyArn
        })
      }
    });

    // Full action set verified against the reference stack's own comment:
    // "AOSS requires a KMS Grant (not a key policy statement) to access the
    // CMK... the correct mechanism is CDK's key.grant(), which creates a KMS
    // Grant." My first pass only granted 2 of these 6 actions — matching
    // the reference's verified set exactly now, not guessing at a subset.
    //
    // Two grantees, not one, and 4 extra actions beyond the base 6 — both
    // empirically required for ASE (Automatic Semantic Enrichment) to work
    // on a customer-managed-key collection. Without either half of this,
    // AOSS's data-plane read/write (the original reason this grant exists)
    // works fine, but ASE's CreateIndex fails partway through provisioning:
    // aoss.amazonaws.com alone gets past "create ingest pipeline" only once
    // es.amazonaws.com is also granted (ASE's ML pipeline runs on the same
    // underlying service the non-Serverless "es" principal represents, not
    // aoss.amazonaws.com's data-plane role alone) — and even with both
    // principals, ASE's ML connector step additionally needs the 4
    // grant-lifecycle/key-pair actions below (ListGrants/RevokeGrant/
    // RetireGrant to manage the sub-grants its connector creates for
    // itself, GenerateDataKeyPair* for the connector's own key material).
    // Confirmed via isolated throwaway-collection testing: this exact
    // principal set + action list is what turned "Access denied to create
    // ML connector" into a successfully provisioned ASE index — a plain
    // kms:* wildcard also worked but is not something to actually grant.
    //
    // EncryptionContext-conditioned rather than a bare Resource:"*" grant —
    // narrows this from "these two AWS services can use this key for
    // anything" to "...only when the operation is on an AOSS collection in
    // this account," mirroring the condition AOSS's own auto-generated
    // grant already uses internally (visible via `aws kms list-grants` on
    // this key: Constraints.EncryptionContextSubset with the same
    // aws:aoss:arn key). Separately verified via the same throwaway-collection
    // method that this condition doesn't break ASE — every stage (ingest
    // pipeline, ML connector, ML model) still provisions successfully with
    // it in place, so this is strictly a least-privilege narrowing, not a
    // functional change.
    for (const principal of ["aoss.amazonaws.com", "es.amazonaws.com"]) {
      key.addToResourcePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          principals: [new iam.ServicePrincipal(principal)],
          actions: [
            "kms:Encrypt",
            "kms:Decrypt",
            "kms:ReEncrypt*",
            "kms:GenerateDataKey*",
            "kms:GenerateDataKeyPair*",
            "kms:DescribeKey",
            "kms:CreateGrant",
            "kms:ListGrants",
            "kms:RevokeGrant",
            "kms:RetireGrant"
          ],
          resources: ["*"],
          conditions: {
            StringLike: {
              "kms:EncryptionContext:aws:aoss:arn": `arn:aws:aoss:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:collection/*`
            }
          }
        })
      );
    }

    // AllowFromPublic and SourceVPCEs are mutually exclusive on an AOSS
    // network policy rule — the API rejects a rule specifying both. Normal
    // (non-testing) shape restricts to the VPC endpoint only.
    const allowPublic = props.allowPublicNetworkAccess ?? false;
    const networkPolicy = new cdk.CfnResource(this, "NetworkPolicy", {
      type: "AWS::OpenSearchServerless::SecurityPolicy",
      properties: {
        Name: appConfig.vectorStore.networkPolicyName,
        Type: "network",
        Policy: JSON.stringify([
          {
            Rules: [
              { ResourceType: "collection", Resource: [`collection/${this.collectionName}`] },
              { ResourceType: "dashboard", Resource: [`collection/${this.collectionName}`] }
            ],
            AllowFromPublic: allowPublic,
            ...(allowPublic ? {} : { SourceVPCEs: [props.aossEndpointId] })
          }
        ])
      }
    });

    const collection = new cdk.CfnResource(this, "Collection", {
      type: "AWS::OpenSearchServerless::Collection",
      properties: {
        Name: this.collectionName,
        Type: "VECTORSEARCH",
        StandbyReplicas: "DISABLED"
      }
    });
    collection.addDependency(encryptionPolicy);
    collection.addDependency(networkPolicy);

    // Data access policy — literal ARN string, not an Fn::ImportValue/Ref
    // intrinsic. The reference stack's own comment states embedding an
    // intrinsic inside this specific JSON-string policy property caused
    // intermittent 403s; props.taskRole.roleArn resolves to a plain string
    // token here (not a cross-stack Ref), so this replica doesn't hit that
    // issue, but the literal-string approach is kept for parity.
    new cdk.CfnResource(this, "DataAccessPolicy", {
      type: "AWS::OpenSearchServerless::AccessPolicy",
      properties: {
        Name: appConfig.vectorStore.dataAccessPolicyName,
        Type: "data",
        Policy: JSON.stringify([
          {
            Rules: [
              {
                ResourceType: "collection",
                Resource: [`collection/${this.collectionName}`],
                // aoss:* kept for everything already working under it; the
                // two explicit actions added for ASE's own pipeline
                // provisioning, matching AWS's ASE docs exactly — see the
                // index rule's comment below for why the wildcard alone
                // can't be trusted for the newer ASE-related actions.
                Permission: ["aoss:*", "aoss:CreateCollectionItems", "aoss:DescribeCollectionItems"]
              },
              {
                ResourceType: "index",
                Resource: [`index/${this.collectionName}/*`],
                // aoss:* alone was empirically insufficient for ASE's index
                // schema operations (GetIndexCommand came back
                // AccessDeniedException: "Access denied to get index" even
                // with this wildcard already in place) — AOSS's access-policy
                // wildcard apparently doesn't expand to cover these newer
                // actions the way an IAM wildcard would. Explicit actions
                // added alongside aoss:* (kept for the existing dense
                // knn_vector document search/index operations, which already
                // work under it) rather than replacing it, matching the exact
                // set AWS's ASE docs show for this resource type.
                Permission: ["aoss:*", "aoss:CreateIndex", "aoss:DescribeIndex", "aoss:UpdateIndex", "aoss:DeleteIndex"]
              },
              // ASE provisions its own service-managed ML model per
              // semantic_enrichment-enabled index — a distinct resource type
              // from collection/index in AOSS's access-policy schema, so it
              // needs its own explicit rule (AWS's ASE docs show this same
              // three-rule shape: collection, index, model). Without this,
              // CreateIndexCommand against an ASE-enabled schema is denied
              // even though the identity policy allows aoss:CreateMLResource.
              {
                ResourceType: "model",
                Resource: [`model/${this.collectionName}/*`],
                Permission: ["aoss:*", "aoss:CreateMLResource"]
              }
            ],
            Principal: [props.taskRole.roleArn, ...(props.additionalDataAccessPrincipals ?? [])]
          }
        ])
      }
    }).addDependency(collection);

    // AWS::OpenSearchServerless::Collection exposes CollectionEndpoint as a
    // direct GetAtt attribute — no manual URL construction needed.
    this.collectionEndpoint = collection.getAtt("CollectionEndpoint").toString();
    this.collectionId = collection.getAtt("Id").toString();
  }
}
