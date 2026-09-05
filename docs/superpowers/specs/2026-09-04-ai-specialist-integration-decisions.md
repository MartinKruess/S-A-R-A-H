# AI Specialist Integration Decisions

## Authentication boundary (approved 2026-09-05)

Sarah uses only the documented integration routes:

| Operation | Authentication | Billing |
| --- | --- | --- |
| OpenAI Responses text/research | User API key | Separate API usage |
| Codex App Server coding | User API key or Codex-managed ChatGPT login | Actual selected API or ChatGPT plan |
| Anthropic Messages / own Agent SDK adapter | User API key | Separate API usage |
| Perplexity research | User API key | Separate API usage |

No cookie extraction, imported consumer session tokens, subscription-to-API
proxy, credential sharing or silent switch from subscription limits to paid API.
Codex owns its managed login and refresh; Sarah neither collects the user's
ChatGPT password nor copies session tokens into its API credential store.
Managed login must remain unavailable if secure isolated session storage fails.

Anthropic's allowance for users signing into an unmodified Claude Code binary
under its hosting terms does not authorize Sarah's own Agent SDK login flow.
That alternative is outside this implementation. Perplexity's API-only choice
reflects the documented supported route, not a claim of an identical prohibition.

The billing disclosure follows verified authentication, not just provider name.
For API paths the warnings below remain mandatory. For managed Codex display a
separate versioned acknowledgement explaining ChatGPT plan access/limits and no
general API entitlement. Do not promise zero costs or unlimited use.

Before distribution recheck current terms, binary license/notices, supported
login and secure storage against the actual shipped version. This design is not
a legal guarantee or permission to bypass provider policies or workspace limits.

Sources checked 2026-09-05:

- https://learn.chatgpt.com/docs/app-server
- https://learn.chatgpt.com/docs/auth
- https://code.claude.com/docs/en/legal-and-compliance
- https://www.perplexity.ai/help-center/en/articles/10354847-api-payment-and-billing

## General external AI API cost warning

When a user selects a separately billed external AI API connection, Sarah must display the following warning prominently before the connection is created:

> **⚠️ Separate API-Kosten**
> Dein bestehendes Abo bei diesem Anbieter kann nicht in Sarah verwendet werden. Sarah nutzt die jeweilige kostenpflichtige API. Dadurch können – insbesondere bei Claude und Perplexity – deutlich höhere Kosten als beim normalen Monatsabo entstehen. Bitte prüfe vor der Verbindung die aktuellen API-Preise und setze ein Ausgabenlimit.

### Acceptance notes

- Show this warning for every separately billed external AI API integration before the connection is confirmed.
- Require an explicit acknowledgement before completing the connection.
- Where supported, link directly to the provider's current API pricing and spending-limit settings.
- Do not imply that a consumer subscription covers API usage unless the provider explicitly supports that authentication and billing path.
- Do not show this exact warning for a Codex connection that is demonstrably using supported ChatGPT subscription access. Codex API-key access remains usage-based and must show the API warning; the detected authentication mode must control the billing copy.
- Do not describe Claude as uniquely or demonstrably more expensive than OpenAI or Perplexity. The detailed Claude example exists because its subscription usage and API costs could be compared concretely, not because it has been proven to be the worst case.
- Treat OpenAI as a potentially substantial cost difference as well: API billing also covers ordinary text conversations that may be available separately under a ChatGPT subscription, in addition to Codex usage.
- Treat Perplexity as a potentially substantial cost difference, but do not publish a comparative multiplier without current, verifiable usage and pricing evidence.

## Detailed Claude connection cost warning

When a user selects Claude as an integration, Sarah must display the following warning prominently before the connection is created:

> ⚠️ **Hinweis zu Claude**
>
> Claude kann in Sarah derzeit nur über die kostenpflichtige Anthropic API verwendet werden. Dein bestehendes Claude Pro- oder Max-Abonnement kann dafür nicht genutzt werden.
>
> Bei intensiver Nutzung können die API-Kosten – insbesondere mit Claude Opus – **ein Vielfaches der Kosten eines vergleichbaren Claude-Abonnements betragen (typischerweise etwa 5–10×, abhängig von der Nutzung).**
>
> Wir empfehlen daher, vor der Verbindung die aktuellen API-Preise und ein Ausgabenlimit bei Anthropic zu prüfen.

### Acceptance notes

- Show the warning as soon as Claude is selected and before the user confirms the connection.
- Do not hide the warning in general terms, documentation, or a post-connection notification.
- Make clear that Claude Pro and Max subscriptions do not cover Anthropic API usage.
- Link to Anthropic's current API pricing and spending-limit settings when the integration is implemented.
- Revalidate the `5–10×` comparison against then-current pricing before release because prices and subscription limits can change.
- Require an explicit acknowledgement before completing the Claude connection.
- The additional detail is based on a concrete personal subscription-to-API comparison. It must not be presented as proof that Claude is more expensive than every other supported provider.
