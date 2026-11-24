# Subagent models: which minds your subagents can run on

Your `subagent` tool can start a child on any model your main mind can select through an edge door. Each route is
`provider` + `model`, exactly as below:

| provider | models |
|---|---|
| `deepseek-official` | `deepseek-flash`, `deepseek-v4-pro` |
| `anthropic-door` | `claude-opus-5-5`, `claude-fable-5-2`, `claude-sonnet-5-5` |
| `openrouter-door` | `moonshotai/kimi-k3.1-pro`, `openai/gpt-6.1-sol`, `openai/gpt-6-astra`, `meta/muse-spark-1.3`, `z-ai/glm-5.3`, `google/gemini-4-argon`, `x-ai/grok-4.7` |

The list ships in the web bundle (`packages/bundle/web-app/cordis.patch.yml`, row `subagent-model-selection-settings`)
and is on by default. The owner can change it on the Plugins page, under Subagent.

## How to pick one

1. `list_subagent_models` with no arguments: the providers this session allows.
2. `list_subagent_models { provider: "openrouter-door" }`: that provider's models.
3. `subagent { description, prompt, provider: "openrouter-door", model: "openai/gpt-6-astra" }`. Leave `provider` and
   `model` out to run the child on your own model. Your own model is always allowed and always listed, marked
   `(your own model)`, even when the session's list does not name it (for example
   `subagent { description, prompt, reasoning_effort: "high" }`).

A child's requests leave by the same door as yours (`/door/openrouter/...`, `/door/anthropic/...`, `/door/deepseek/...`),
and the edge adds the key there. Nothing in your body holds a provider key.

## What "unavailable" means

In this synthetic example, `openrouter-door/openai/gpt-6-astra - unavailable: OpenRouter is switched on but has no key at the edge` means the route
is on, but the edge reports no key for its door (`GET /api/health`, `capabilities.providerDoors`), so a child there would
fail. Pick another route, or ask the owner to set that key at the edge. The check is made on every listing. A line
`Edge key check not run: ...` means the edge could not tell; the routes are listed and nothing is claimed either way.
A key stored on the Models page is not seen by this check.

## New sessions only

The list is fixed when a session starts. A Settings change reaches new sessions only: an older thread keeps the list it
started with (or, if it started with none, only its own model). If a route you expect is missing, start a new thread.

## Consult or subagent

- `x6_consult`: a prompt to another model (or a council of up to 12), answers back. Use it for a second opinion.
- `subagent`: a whole agent on that model, with its own tools and context, working a task; its result comes back to you.
- Both use the same doors and keys.

### How much room a consult gets

- Leave `maxTokens` and `timeoutMs` out unless you have a reason. With no `maxTokens`, each model gets its own output
  ceiling from the model catalogue (128,000 for the pill models; 32,000 for a model the catalogue does not list),
  thinking included; the default time is 600,000 ms (10 minutes). You may ask for up to 128,000 and 1,800,000 ms.
- A thinking model spends its cap on thinking first: a small cap can leave no answer at all
  (`CONSULT_REASONING_EXHAUSTED_MAX_TOKENS`). A short time cuts it off before its first word (`CONSULT_TIMEOUT`).
- Nothing is asked twice. An answer cut by its cap comes back as it is, with `capped: true`, its `stopReason` and
  `tokensUsed`, so each call is paid once and you decide what to do next. A cancel stays `CONSULT_CANCELLED`.
- `x6_swarm` workers are consults: the same defaults and ceilings.
- An answer can be up to 1 MiB of text. A cut answer keeps its text, says `truncated: true`, and says in `next` how to
  get the rest.
