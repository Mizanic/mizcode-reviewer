import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { APP_KEY_PARAMETER, CLIENT_SECRET_PARAMETER, McpStack } from "../src/stack.ts";

describe("McpStack", () => {
  let template: Template;

  beforeAll(() => {
    const app = new App();
    const stack = new McpStack(app, "Test", {
      env: { region: "us-east-1" },
      appId: "5312457",
      clientId: "Iv23libdXUQOTm5d8vFp",
    });
    template = Template.fromStack(stack);
  }, 60_000);

  it("runs the handler as a Node 22 Lambda with the public IDs and the parameter names", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs22.x",
      Handler: "index.handler",
      Environment: {
        Variables: {
          MIZCODE_APP_ID: "5312457",
          MIZCODE_CLIENT_ID: "Iv23libdXUQOTm5d8vFp",
          MIZCODE_APP_KEY_PARAMETER: APP_KEY_PARAMETER,
          MIZCODE_CLIENT_SECRET_PARAMETER: CLIENT_SECRET_PARAMETER,
        },
      },
    });
    template.resourceCountIs("AWS::Lambda::Function", 1);
  });

  it("gives the function no URL of its own, so only the REST API reaches it", () => {
    template.resourceCountIs("AWS::Lambda::Url", 0);
  });

  it("serves ANY /mcp from a Regional REST API through Lambda proxy integration", () => {
    template.hasResourceProperties("AWS::ApiGateway::RestApi", {
      EndpointConfiguration: { Types: ["REGIONAL"] },
    });
    template.hasResourceProperties("AWS::ApiGateway::Resource", { PathPart: "mcp" });
    template.hasResourceProperties("AWS::ApiGateway::Method", {
      HttpMethod: "ANY",
      AuthorizationType: "NONE",
      Integration: { Type: "AWS_PROXY", IntegrationHttpMethod: "POST" },
    });
    template.resourceCountIs("AWS::ApiGateway::Method", 1);
  });

  it("limits the stage's request rate", () => {
    template.hasResourceProperties("AWS::ApiGateway::Stage", {
      MethodSettings: Match.arrayWith([
        Match.objectLike({ HttpMethod: "*", ResourcePath: "/*", ThrottlingRateLimit: 10, ThrottlingBurstLimit: 20 }),
      ]),
    });
  });

  it("lets the function read only the two parameters", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    const statements = Object.values(policies).flatMap(
      (policy) => (policy as { Properties: { PolicyDocument: { Statement: unknown[] } } }).Properties.PolicyDocument.Statement,
    );
    expect(statements).toHaveLength(1);
    const text = JSON.stringify(statements[0]);
    expect(text).toContain('"Action":"ssm:GetParameters"');
    expect(text).toContain(":parameter/mizcode-reviewer/app-private-key");
    expect(text).toContain(":parameter/mizcode-reviewer/client-secret");
  });

  it("keeps logs for three months", () => {
    template.hasResourceProperties("AWS::Logs::LogGroup", { RetentionInDays: 90 });
  });

  it("creates no parameter and holds no secret value", () => {
    template.resourceCountIs("AWS::SSM::Parameter", 0);
    template.resourceCountIs("AWS::SecretsManager::Secret", 0);
    const text = JSON.stringify(template.toJSON());
    expect(text).not.toContain("PRIVATE KEY");
    expect(text).not.toMatch(/ghu_|ghs_|ghr_/);
  });

  it("prints the MCP URL", () => {
    template.hasOutput("McpUrl", {});
  });
});
