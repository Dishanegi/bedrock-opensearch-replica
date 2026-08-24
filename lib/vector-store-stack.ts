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
    key.grant(
      new iam.ServicePrincipal("aoss.amazonaws.com"),
      "kms:Encrypt",
      "kms:Decrypt",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:DescribeKey",
      "kms:CreateGrant"
    );

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
            AllowFromPublic: false,
            SourceVPCEs: [props.aossEndpointId]
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
                Permission: ["aoss:*"]
              },
              {
                ResourceType: "index",
                Resource: [`index/${this.collectionName}/*`],
                Permission: ["aoss:*"]
              }
            ],
            Principal: [props.taskRole.roleArn]
          }
        ])
      }
    }).addDependency(collection);

    // AWS::OpenSearchServerless::Collection exposes CollectionEndpoint as a
    // direct GetAtt attribute — no manual URL construction needed.
    this.collectionEndpoint = collection.getAtt("CollectionEndpoint").toString();
  }
}
