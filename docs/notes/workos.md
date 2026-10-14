# Getting the GitHub username from a WorkOS token

Question: in `auth.mode = "workos"`, how does the server learn the GitHub username of the person who called `submit_review`? The server needs the username to check the caller's permission on the repo with `GET /repos/{owner}/{repo}/collaborators/{username}/permission`.

Researched 2026-10-14 against the WorkOS docs, the GitHub REST API description and the MCP spec 2025-11-25.

## Answer

The access token does not carry the GitHub username. The server can get it from the WorkOS user ID in the token with two API calls:

1. Verify the access token against the AuthKit JWKS. Check `iss` and `aud`. Read `sub`, which is the WorkOS user ID.
2. Call WorkOS `GET /user_management/users/{sub}/identities` with the WorkOS API key. Pick the identity whose `provider` is `GitHubOAuth`. Its `idp_id` is the user's ID at GitHub.
3. Call GitHub `GET /user/{account_id}` with that ID. The response's `login` is the GitHub username.

Two facts in step 2 are not confirmed by the docs and must be tested with a real GitHub sign-in before P4 code is written:

- that a GitHub sign-in produces an identity with `provider` set to `GitHubOAuth`. The docs only show a `MicrosoftOAuth` example;
- that `idp_id` holds GitHub's numeric user ID. The docs don't define `idp_id`, and the Microsoft example is a GUID.

If either fails, this route is closed and the choice of WorkOS needs to be revisited.

## Evidence

### The token has no GitHub field

WorkOS, [Access token claims](https://workos.com/docs/authkit/connect/token-claims): "Connect issues user tokens to OAuth applications and MCP clients, including those registered through Dynamic Client Registration (DCR) or Client ID Metadata Document (CIMD)." The claim table lists `iss`, `aud`, `sub`, `client_id`, `org_id`, `sid`, `scope`, `jti`, `exp`, `iat`. For user tokens, `sub` is "User ID".

The same page: "User tokens can include additional claims from your environment's JWT template."

### A JWT template can't add it either

WorkOS, [JWT templates](https://workos.com/docs/authkit/jwt-templates): a template renders into "WorkOS Connect access tokens issued to OAuth applications and to MCP clients registered through Dynamic Client Registration or Client ID Metadata Document". The template context offers `user.*`, `organization.*` and `organization_membership.*`. It has no identity or provider fields, so it can't add the GitHub login. It can add `user.external_id` or `user.metadata`, but only if something writes the GitHub ID there first.

### The identities endpoint links the WorkOS user to GitHub

WorkOS, [Identities](https://workos.com/docs/reference/authkit/identity): "Represents User identities obtained from external identity providers. When a user authenticates using an external provider like Google OAuth, information from that provider will be made available as one of the user's Identities."

Endpoint: `GET /user_management/users/{id}/identities`. Example response:

```json
[{ "idp_id": "4F42ABDE-1E44-4B66-824A-5F733C037A6D", "type": "OAuth", "provider": "MicrosoftOAuth" }]
```

"Applications should check the `type` before making assumptions about the shape of the identity."

WorkOS, [GitHub OAuth](https://workos.com/docs/integrations/github-oauth): "The `provider` query parameter should be set to `GitHubOAuth`."

### GitHub resolves a user ID to a username

GitHub REST API, "Get a user using their ID" (`GET /user/{account_id}`): "This method takes their durable user `ID` instead of their `login`, which can change over time."

Because a login can change, the server should look it up on each request rather than store it.

### Token checks the server must do

WorkOS, [MCP](https://workos.com/docs/authkit/mcp): "Access tokens will be issued with an `aud` claim that matches the requested `resource`." The example verifies against `https://authkit_domain/oauth2/jwks` with the AuthKit domain as `issuer`.

MCP spec 2025-11-25, Authorization: "MCP servers **MUST** validate that access tokens were issued specifically for them as the intended audience". It also says: "The MCP server **MUST NOT** pass through the token it received from the MCP client."

## Routes ruled out

- **"Return GitHub OAuth tokens".** WorkOS GitHub OAuth docs: "the access token from GitHub will be included in the response from the Authenticate with code API." In the MCP flow the MCP client exchanges the code with AuthKit, and the server never calls that API. I believe this makes the option unusable here. Not tested.
- **Putting the login in the token.** Not possible directly, as shown above.

## Setup notes for P4

- **Client registration.** WorkOS MCP docs: "Client ID Metadata Document is off by default, but you should enable it in the WorkOS Dashboard under *Connect* → *Configuration*." Dynamic Client Registration can be turned on for older MCP clients.
- **Resource Indicator.** Add the server's MCP URL as a Resource Indicator so the tokens carry the right `aud`.
- **GitHub credentials.** GitHub sign-in needs a GitHub OAuth App or GitHub App in the WorkOS dashboard. WorkOS docs: "When using a GitHub App, OAuth scopes are not applicable... Be sure to set the **Email addresses** account permission to **Read-only**."
- **Staging test.** WorkOS docs: "The default credentials are only intended for testing and therefore only available in the Staging environment." A staging environment can test the two open facts without setting up GitHub credentials.
- **API key.** The server needs a WorkOS API key, stored in Secrets Manager, for the identities call.
