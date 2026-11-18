# Hookcrest agent kit

A dependency-free Node 22.13+ stdio bridge and CLI for Hookcrest's hosted MCP.
Tool definitions and authenticated workflows come from Hookcrest; this package
contains one entry-point skill. A Hookcrest account is required.

## Claude Code

```text
/plugin marketplace add Techsynkinc/hookcrest-agent-kit
/plugin install hookcrest@hookcrest
```

For a local checkout: `claude --plugin-dir /absolute/path/to/hookcrest-agent-kit`.

## Codex and ChatGPT

The `.codex-plugin/plugin.json` compatibility manifest declares `./skills/` and
`./.codex-mcp.json`, following [OpenAI's plugin packaging guide](https://developers.openai.com/api/docs/guides/agents-api/tools/plugins).
Install from a local marketplace in Codex's plugin manager. The stdio server
requires Node on the computer running the plugin. Local plugin availability
varies by client; ChatGPT can use the hosted connection below.

## Hosted connection

In claude.ai, ChatGPT or Claude Desktop, add a custom connector with URL
`https://app.hookcrest.com/mcp`, then sign in through OAuth. No local kit is
required. Clients must support Streamable HTTP and OAuth.

## Sign in and use

With the local bridge, ask the agent to call `hookcrest_login`, open its approval
link, check the code and approve the workspace, then call `hookcrest_login` again.
Or run:

```sh
node bin/hookcrest.js login
node bin/hookcrest.js status
node bin/hookcrest.js tools
node bin/hookcrest.js <tool> --option value --json
```

Optional: `npm link` exposes `hookcrest` and `hookcrest-mcp` on PATH.
Settings live in `~/.hookcrest/config.json` (`url`, `apiKey`), overridden by
`HOOKCREST_URL` and `HOOKCREST_API_KEY`. `HOOKCREST_CONFIG` selects another config
file. The default URL is `https://app.hookcrest.com`. Revoke keys in Hookcrest
Settings → API keys.

Local `influencer_photo` accepts `file` paths; on a Mac, HEIC/TIFF and images over
5 MB are converted with `sips`. `post_preview --save-dir <folder>` saves the
returned preview images at server preview resolution. The CLI preview shortcut
saves to `./hookcrest-previews` by default.

TikTok drafts only. Show cost before paid calls and wait for a yes. Show the exact
reply text and receive a yes before sending replies. Ads never spend.

Proprietary; see [LICENSE](LICENSE).
