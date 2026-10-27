# Company search, page fetching, and Skills

## Search and fetching use separate providers

The Company profile selects `p7` for `web_search`. The managed MCP tool
`mcp__p7__search__web_search` also uses P7. Both use the deployment-owned search
service through P7's governed provider egress; the client does not choose an
external search engine itself.

The current self-hosted search service is SearXNG. It aggregates external search
engines, so hosting the service does not remove those engines' rate limits. An
empty result accompanied by engine failures remains a failed search, rather than
being presented as evidence that nothing was found.

`web_fetch` retrieves the body of an already-known URL. There is currently no
Company P7 page-fetch endpoint, so the Company default is the bundled `http`
provider. It fetches the public page directly through Harness's HTTP transport.

Upstream's base bundle also mounts `web-deepseek-api`, which registers
`deepseek-search-api` and `deepseek-fetch-api`. Provider registration alone does
not prove that a DeepSeek key is configured or that a request reached DeepSeek.
Company disables this unused default mount. Explicit Profile/environment
provider choices and explicit row enablement remain user-owned.

## Login and errors

The P7 search provider follows the account broker even when it becomes available
after plugin startup. Login and restore refresh readiness; logout immediately
invalidates it. An in-flight read from an older account state cannot republish
or dispatch its token. Removing a personal broker does not silently resume a
shared key. Profiles explicitly operating in shared-key mode remain supported.

Company MCP errors distinguish authentication (401), authorization (403), input
validation (422), capacity/rate limits (429), and upstream failures (502/504).
Untrusted supplier messages and credential-bearing response bodies are not
copied into errors. Upstream failures do not trigger tool-directory discovery
or automatic replay of a tool call. Cancelling a call also cancels its MCP
initialization notification.

## Skill entry points in the pinned Harness

- The conversation's `/` menu lists Skills available to the current Agent.
- Selecting a known Skill can open its provider-supplied `SKILL.md` in the right
  sidebar. Skills without a file path can still be invoked without a preview.
- **Plugins** manages profile bundles and their configuration. A bundle may
  contribute Skills, but this is not a standalone Skill library manager.
- **Settings → Built-in plugins** shows built-in inventory and runtime status.

The pinned Harness does not provide a separate page for uploading, editing,
publishing, or assigning company-wide Skills. Those operations would require a
separate product feature.
