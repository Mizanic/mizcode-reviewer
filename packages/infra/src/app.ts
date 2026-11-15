// The CDK app for plan B. From packages/infra:
//
//   npx cdk synth
//   npx cdk deploy --profile <the AWS profile for the plan B account>
//
// The account comes from the profile, so no account ID is in this repo. The
// two SecureString parameters must exist before the first request; see
// stack.ts.

import { App } from "aws-cdk-lib";
import { McpStack } from "./stack.ts";

const app = new App();
new McpStack(app, "MizcodeReviewer", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: "us-east-1" },
  appId: "5312457",
  clientId: "Iv23libdXUQOTm5d8vFp",
});
