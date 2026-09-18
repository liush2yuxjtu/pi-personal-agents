# Pi Personal Agents

A local, personal TUI and OpenAI Agents API-shaped adapter backed by Pi.

This project keeps one application Git history. Open Managed Agents is a pinned Git submodule dependency at `vendor/open-managed-agents`; it supplies the audited OpenAI Agents session router and contracts. It is not a fork.

## What it does

- Runs Pi through JSONL RPC with an exact `openai-codex/gpt-5.6-luna` model pin.
- Exposes a loopback-only `/openai/v1/agents/sessions` surface.
- Supports session creation, SSE events, continuation, cancellation, items, turns, and idempotency.
- Provides a Pi-style TUI with `简体中文 + proactive` defaults.
- Reviews GitHub pull requests in read-only mode and triages findings as `P0/P1/P2` with `BLOCK/NEEDS_WORK/READY` verdicts.
- Keeps local preferences and session state outside Git.

This is a play prototype, not a public service or production multi-user runtime. It does not comment, push, merge, deploy, access MCP servers, or expose arbitrary shell tools.

## Requirements

- Node.js 24+
- `git`
- Pi installed and authenticated locally with `openai-codex/gpt-5.6-luna`

## Setup

```bash
git clone --recurse-submodules https://github.com/liush2yuxjtu/pi-personal-agents.git
cd pi-personal-agents
npm install
```

If cloned without `--recurse-submodules`:

```bash
git submodule update --init --depth 1
npm install
```

The dependency is pinned in Git. Update it deliberately:

```bash
git -C vendor/open-managed-agents fetch origin main
git -C vendor/open-managed-agents checkout <reviewed-commit>
git add vendor/open-managed-agents
git commit -m "chore: update OpenMA dependency"
```

## Play

```bash
npm run dev
```

Commands:

```text
/review https://github.com/OWNER/REPO/pull/NUMBER
/output-style
/output-style concise
/output-style proactive
/output-style explanatory
/output-style learning
/language 简体中文
/config
/new
/sessions
/quit
Ctrl+C  cancel current turn; exit when idle
```

A bare GitHub PR URL is also recognized as a review request.

## One-shot review

```bash
npm run pr-review -- https://github.com/OWNER/REPO/pull/NUMBER
```

Public PR metadata and diffs use GitHub's read-only HTTP endpoints. `GITHUB_TOKEN`, when supplied, stays in the host process and is never sent to Pi as a model message.

## Local API

```bash
OPENMA_PERSONAL_API_KEY='choose-a-local-secret' npm run serve
```

Base URL:

```text
http://127.0.0.1:8788/openai/v1
```

Requires `OpenAI-Beta: agents=v1` and a bearer API key. The server rejects non-loopback bind addresses.

## Verification

```bash
npm run typecheck
npm test
```

The tests use a fake Pi RPC process for deterministic lifecycle checks. Live model use is separate and costs provider tokens.

## License and upstream

This repository uses Apache-2.0. Open Managed Agents remains an external Apache-2.0 dependency under `vendor/open-managed-agents`; retain its `LICENSE` and `NOTICE` when updating the submodule. See the upstream project at https://github.com/openma-ai/open-managed-agents.
