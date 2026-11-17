# Decisions

## 2026-11-17

- Use CadenceDesk AI and `cadencedesk`, as specified by the explicit brand configuration. Domain, verified sender, support address, pricing and legal copy remain owner settings.
- Use [Postiz commit 36d5fc7](https://github.com/gitroomhq/postiz-app/commit/36d5fc7b3ac3f17178b1589cf7a7337523017a41) as the initial source baseline. This is an observed main-line commit from September 3, 2026. Current hosted documentation may describe later behavior. GitHub was reachable through web research, but the local Git clone could not connect over HTTPS.
- Implement independently using product behavior and official provider contracts. The [Postiz license](https://github.com/gitroomhq/postiz-app/blob/36d5fc7b3ac3f17178b1589cf7a7337523017a41/LICENSE) is AGPL-3.0. Section 13 addresses network users' access to corresponding source for modified versions. No upstream implementation or product assets were copied.
- Treat [hosted pricing](https://postiz.com/pricing) as public plan evidence. It advertises MCP, CLI and API across paid plans and lists plan-specific capacity. Account-level enforcement and actual provider approval remain unverified.
