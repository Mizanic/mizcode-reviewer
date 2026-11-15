// Plan B in AWS: an API Gateway REST API with one route, ANY /mcp, sending
// every request to a Lambda Event Function through Lambda proxy integration.
// The function runs packages/server/src/lambda.ts. The gateway does no auth:
// the code checks the token on every tool call.
//
// The App private key and the App's client secret are SecureString
// parameters in SSM Parameter Store. CloudFormation can't create
// SecureString parameters, so they are not in this stack: the owner puts them
// in once with aws ssm put-parameter, and the stack only lets the function
// read those two names. No secret value is ever in the template.

import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { EndpointType, LambdaIntegration, RestApi } from "aws-cdk-lib/aws-apigateway";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";

export const APP_KEY_PARAMETER = "/mizcode-reviewer/app-private-key";
export const CLIENT_SECRET_PARAMETER = "/mizcode-reviewer/client-secret";

export interface McpStackProps extends StackProps {
  // The mizcode-reviewer App's ID and client ID. Both are public.
  appId: string;
  clientId: string;
}

export class McpStack extends Stack {
  constructor(scope: Construct, id: string, props: McpStackProps) {
    super(scope, id, props);

    const logGroup = new LogGroup(this, "Logs", {
      retention: RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const handler = new NodejsFunction(this, "Handler", {
      entry: fileURLToPath(new URL("../../server/src/lambda.ts", import.meta.url)),
      handler: "handler",
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      // Under the REST API's 29-second limit, so a slow GitHub call ends in
      // the function's own error, not the gateway's.
      timeout: Duration.seconds(25),
      logGroup,
      environment: {
        MIZCODE_APP_ID: props.appId,
        MIZCODE_CLIENT_ID: props.clientId,
        MIZCODE_APP_KEY_PARAMETER: APP_KEY_PARAMETER,
        MIZCODE_CLIENT_SECRET_PARAMETER: CLIENT_SECRET_PARAMETER,
      },
      bundling: {
        format: OutputFormat.ESM,
        target: "node22",
        // The Lambda Node runtime already has the AWS SDK.
        externalModules: ["@aws-sdk/*"],
        // Some bundled packages call require(), which an ES module lacks.
        banner: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
    });

    // The parameters use the AWS managed key aws/ssm, whose key policy lets
    // any role in this account decrypt through SSM, so no KMS grant is needed.
    handler.addToRolePolicy(
      new PolicyStatement({
        actions: ["ssm:GetParameters"],
        resources: [APP_KEY_PARAMETER, CLIENT_SECRET_PARAMETER].map((name) =>
          this.formatArn({ service: "ssm", resource: "parameter", resourceName: name.slice(1) }),
        ),
      }),
    );

    const api = new RestApi(this, "Api", {
      restApiName: "mizcode-reviewer",
      endpointConfiguration: { types: [EndpointType.REGIONAL] },
      // No account-wide API Gateway logging role.
      cloudWatchRole: false,
      deployOptions: {
        stageName: "v1",
        throttlingRateLimit: 10,
        throttlingBurstLimit: 20,
      },
    });
    // ANY sends every method to the code, so the server answers exactly as it
    // does locally, not with API Gateway's own 403 for an unknown method.
    api.root.addResource("mcp").addMethod("ANY", new LambdaIntegration(handler, { proxy: true }));

    new CfnOutput(this, "McpUrl", { value: `${api.url}mcp`, description: "The MCP server URL for the plugin" });
  }
}
