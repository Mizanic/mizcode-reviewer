# Getting the GitHub username from a WorkOS token

With `auth.mode = "workos"`, the server has to learn the GitHub username of whoever called `submit_review`. It needs that username to check the caller's permission on the repo through `GET /repos/{owner}/{repo}/collaborators/{username}/permission`.

I researched this on 2026-10-14 against the WorkOS docs, the GitHub REST API description and the MCP spec dated 2025-11-25.

## Answer

The access token doesn't carry the GitHub username. The server can still get it from the WorkOS user ID in the token, with two API calls.

1. Verify the access token against the AuthKit JWKS, check `iss` and `aud`, and read `sub`. That claim is the WorkOS user ID.
2. Call WorkOS `GET /user_management/users/{sub}/identities` with the WorkOS API key. Pick the identity whose `provider` is `GitHubOAuth`. Its `idp_id` should be the user's ID at GitHub.
3. Call GitHub `GET /user/{account_id}` with that ID. The `login` field in the response is the GitHub username.

The docs don't confirm two facts in step 2. Test both with a real GitHub sign-in before writing the P4 code.

- A GitHub sign-in should produce an identity with `provider` set to `GitHubOAuth`. The docs only show a `MicrosoftOAuth` example.
- The `idp_id` field should hold GitHub's numeric user ID. The docs never define `idp_id`, and the Microsoft example is a GUID.

If either fact is false, this route is closed and the choice of WorkOS needs another look.

## Evidence

### The token has no GitHub field

WorkOS, [Access token claims](https://workos.com/docs/authkit/connect/token-claims), says "Connect issues user tokens to OAuth applications and MCP clients, including those registered through Dynamic Client Registration (DCR) or Client ID Metadata Document (CIMD)." Its claim table lists `iss`, `aud`, `sub`, `client_id`, `org_id`, `sid`, `scope`, `jti`, `exp` and `iat`. For user tokens it describes `sub` as "User ID".

The same page says "User tokens can include additional claims from your environment's JWT template."

### A JWT template can't add it either

WorkOS, [JWT templates](https://workos.com/docs/authkit/jwt-templates), says a template renders into "WorkOS Connect access tokens issued to OAuth applications and to MCP clients registered through Dynamic Client Registration or Client ID Metadata Document". Templates can read `user.*`, `organization.*` and `organization_membership.*`. Nothing in that list covers identities or providers, so a template can't add the GitHub login. It can add `user.external_id` or `user.metadata`, but something would have to write the GitHub ID there first.

### The identities endpoint links the WorkOS user to GitHub

WorkOS, [Identities](https://workos.com/docs/reference/authkit/identity), says "Represents User identities obtained from external identity providers. When a user authenticates using an external provider like Google OAuth, information from that provider will be made available as one of the user's Identities."

The endpoint is `GET /user_management/users/{id}/identities`, and the docs give this example response.

```json
[{ "idp_id": "4F42ABDE-1E44-4B66-824A-5F733C037A6D", "type": "OAuth", "provider": "MicrosoftOAuth" }]
```

The page also warns "Applications should check the `type` before making assumptions about the shape of the identity."

WorkOS, [GitHub OAuth](https://workos.com/docs/integrations/github-oauth), says "The `provider` query parameter should be set to `GitHubOAuth`."

### GitHub turns a user ID into a username

The GitHub REST API entry "Get a user using their ID", `GET /user/{account_id}`, says "This method takes their durable user `ID` instead of their `login`, which can change over time."

A login can change, so the server should look it up on every request and never store it.

### Token checks the server must make

WorkOS, [MCP](https://workos.com/docs/authkit/mcp), says "Access tokens will be issued with an `aud` claim that matches the requested `resource`." Its example verifies tokens against `https://authkit_domain/oauth2/jwks` and passes the AuthKit domain as `issuer`.

The MCP spec, 2025-11-25, Authorization, says "MCP servers **MUST** validate that access tokens were issued specifically for them as the intended audience". It also says "The MCP server **MUST NOT** pass through the token it received from the MCP client."

## Routes ruled out

WorkOS can return the user's GitHub token. Its GitHub OAuth page says "the access token from GitHub will be included in the response from the Authenticate with code API." In the MCP flow the MCP client exchanges the code with AuthKit, and our server never calls that API. I believe that rules this option out, but I haven't tested it.

The token can't carry the login directly, for the reasons above.

## Setup notes for P4

- Turn on Client ID Metadata Document. The WorkOS MCP docs say "Client ID Metadata Document is off by default, but you should enable it in the WorkOS Dashboard under *Connect* → *Configuration*." Dynamic Client Registration can be turned on as well, for older MCP clients.
- Add the server's MCP URL as a Resource Indicator, so tokens carry the right `aud`.
- GitHub sign-in needs a GitHub OAuth App or a GitHub App configured in the WorkOS dashboard. The WorkOS docs say "When using a GitHub App, OAuth scopes are not applicable... Be sure to set the **Email addresses** account permission to **Read-only**."
- A WorkOS staging environment can test the two open facts without any GitHub setup. The WorkOS docs say "The default credentials are only intended for testing and therefore only available in the Staging environment."
- The identities call needs a WorkOS API key. Store it in Secrets Manager.
