# cli-gateway

**One OpenAI-compatible API in front of many AI CLIs.** Point any OpenAI/OpenRouter
client (Home Assistant, the OpenAI SDK, LangChain, …) at this server, pick a model like
`gemini/flash` or `claude/opus`, and the request is routed to the matching logged-in
CLI. Turn the free/subscription CLIs you already have into a drop-in API — no per-token
API billing for your own tinkering.

Zero runtime dependencies (Node stdlib only). Add a new backend by dropping one file in
`adapters/`.

```
 OpenAI client ──▶  cli-gateway  ──▶  claude | gemini | codex | grok  (CLIs)
                    (one port)        each wrapped by a small adapter module
```

## Layout

```
cli-gateway/
├── server.js        # CORE: HTTP, auth, OpenAI I/O + SSE, model routing
├── lib/
│   ├── core.js      #   shared: message flattening, spawning, formatting
│   └── registry.js  #   auto-loads adapters, builds the model index
├── adapters/        # one module per CLI  ← add backends here
│   ├── claude.js    #   ✅ verified end-to-end
│   ├── gemini.js    #   ⚠️ wired — needs auth to verify
│   ├── codex.js     #   ⚠️ wired — needs auth to verify
│   └── grok.js      #   ⚠️ wired — needs auth to verify
├── config.json
└── README.md
```

## Run

```bash
node server.js
# → http://0.0.0.0:8787/v1
```

On boot it prints which backends are ready (CLI found on PATH) and how many models
are available.

## Config (`config.json`, overridable by env)

| key / env                              | default            | meaning                                   |
| -------------------------------------- | ------------------ | ----------------------------------------- |
| `port` / `GATEWAY_PORT`                | `8787`             | listen port                               |
| `host` / `GATEWAY_HOST`                | `0.0.0.0`          | bind address                              |
| `apiKey` / `GATEWAY_KEY`               | *(none)*           | if set, clients must send `Bearer <key>`  |
| `defaultModel` / `GATEWAY_DEFAULT_MODEL` | `claude/sonnet`  | used when a request omits `model`         |
| `toolModel` / `GATEWAY_TOOL_MODEL`     | `claude/sonnet`    | requests that include `tools` use THIS model (weak models call tools unreliably); empty = no upgrade |
| `defaultSystem` / `GATEWAY_SYSTEM`     | `You are a helpful assistant.` | system prompt when none given |
| `adapters.<id>.enabled`                | `true`             | turn a backend off                        |
| `adapters.<id>.bin`                    | the CLI name       | path/override for the CLI binary          |
| `adapters.<id>.cwd`                    | gateway cwd        | working dir for that CLI                   |
| `adapters.<id>.allowTools`             | `false`            | let the CLI use its tools (else text-only)|

**Single auth:** set one `apiKey` for the gateway; each backend CLI keeps its own login.

## Endpoints

- `POST /v1/chat/completions` — streaming + non-streaming
- `GET  /v1/models` — every model from every ready backend (`owned_by` = backend)
- `GET  /health` — backends + model count (no auth)

## Models

Namespaced as `backend/model`, resolvable three ways: full (`claude/opus`), bare
(`opus`), or alias. `GET /v1/models` lists them all. Current set:

| backend  | models (aliases)                                                     |
| -------- | -------------------------------------------------------------------- |
| `claude` | `claude-opus-4-8` (opus), `claude-sonnet-4-6` (sonnet), `claude-haiku-4-5-20251001` (haiku) |
| `gemini` | `gemini-2.5-pro` (pro), `gemini-2.5-flash` (flash), `gemini-2.5-flash-lite` (flash-lite), `gemini-2.0-flash` |
| `codex`  | `gpt-5-codex` (codex), `gpt-5`, `o3`, `o4-mini` (mini)               |
| `grok`   | `grok-4` (grok), `grok-4-fast` (fast), `grok-code-fast-1` (code), `grok-3` |

Model lists are curated per adapter (works offline). Each adapter can override
`listModels()` to pull them dynamically if its CLI supports it.

## Authenticating each backend

The gateway only works for a backend once its CLI is logged in. These are **your**
one-time steps (interactive logins can't be done by the server):

| backend  | how to authenticate                                              | free tier? |
| -------- | --------------------------------------------------------------- | ---------- |
| `claude` | `claude` (Pro/Max) or `ANTHROPIC_API_KEY`                       | no (sub/API) |
| `gemini` | `export GEMINI_API_KEY=...` (free from aistudio.google.com) **or** run `gemini` and log in with Google | **yes** |
| `codex`  | `codex login` (ChatGPT Plus/Pro) or `OPENAI_API_KEY`           | no (sub/API) |
| `grok`   | `export XAI_API_KEY=...`                                        | no (paid)  |

After logging a backend in, restart the gateway (or just send a request) and verify:

```bash
curl http://localhost:8787/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"gemini/flash","messages":[{"role":"user","content":"say hi"}]}'
```

## Use it

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8787/v1", api_key="unused")  # or GATEWAY_KEY
print(client.chat.completions.create(
    model="gemini/flash",
    messages=[{"role": "user", "content": "Hello!"}],
).choices[0].message.content)
```

### Home Assistant

Use the "OpenAI Conversation" integration (or any OpenAI-compatible one), set the base
URL to `http://<this-host>:8787/v1`, the API key to your `GATEWAY_KEY`, and the model to
e.g. `gemini/flash`.

## Adding a new CLI (the whole point)

Drop a file in `adapters/` exporting this shape — the registry auto-discovers it:

```js
module.exports = {
  id: 'mycli',                       // namespace + default binary name
  bin: 'mycli',                      // CLI binary (overridable in config)
  models: [{ id: 'big', alias: ['b'] }],   // or implement listModels(cfg)
  buildArgs({ prompt, system, model, stream, cfg }) {
    return ['--prompt', prompt, '--model', model, stream ? '--stream' : '--json'];
  },
  parseFinal(stdout) {               // non-stream: return the whole answer
    const d = JSON.parse(stdout);
    return { text: d.text, finishReason: 'stop',
             usage: { prompt_tokens: d.in||0, completion_tokens: d.out||0 } };
  },
  parseStreamLine(line, emit) {      // stream: called per stdout line
    const d = JSON.parse(line);
    if (d.delta) emit({ delta: d.delta });
    if (d.done)  emit({ usage: {...}, finishReason: 'stop' });
  },
};
```

The core handles HTTP, auth, OpenAI framing, SSE, spawning, and routing. An adapter only
describes **how to call one CLI** and **how to read its output**.

## Function calling (tools)

Full OpenAI function-calling is supported, so assistant frameworks (openclaw, Home
Assistant, etc.) can expose real tools. Send `tools` / `tool_choice` as usual:

```jsonc
{
  "model": "claude/haiku",
  "messages": [{ "role": "user", "content": "add milk to my list" }],
  "tools": [{ "type": "function", "function": {
    "name": "add_todo", "description": "Add an item to the todo list",
    "parameters": { "type": "object", "properties": { "item": { "type": "string" } }, "required": ["item"] }
  }}]
}
```

The model replies with a standard `tool_calls` message (`finish_reason: "tool_calls"`),
your client runs the function and sends the result back as a `tool` message, and the
model continues to a final answer. Works streaming and non-streaming, and across every
backend.

**How it works:** these CLIs are agent harnesses with their own tools, not raw model
endpoints, so there's no native `tools` pass-through. The core instead runs a
**prompt-based shim** — it injects your tool schemas into the system prompt, tells the
model that emitting a specific JSON object *is* the way to act, parses that back into
OpenAI `tool_calls`, and folds returned `tool` results into the transcript.
`tool_choice` supports `auto` (default), `none`, `required`, and a specific function.

**Model reliability matters a lot here.** With a *long* tool list and a big assistant
persona in the system prompt, weak models narrate instead of calling ("the tool isn't
available") — measured ~1/4 for haiku vs 4/4 for sonnet. So:
- the shim puts a high-recency reminder at the end of the prompt to push compliance, and
- `toolModel` (default `claude/sonnet`) routes any request containing `tools` to a strong
  model automatically, so a client can send a cheap model for chat and still get reliable
  tool calls. Set `toolModel` to `""` to disable.

**Caveat:** it's *emulated*, so reliability depends on the model emitting clean JSON, and
multi-step "load a connector then use it" flows lean on the model calling the loader
first. When `tools` are present, replies are buffered (not token-streamed) so the gateway
can tell a tool call from prose before responding.

## Caveats

- **Sampling params ignored** (`temperature`, `top_p`, `max_tokens`, `stop`) — these CLIs
  don't expose them.
- **Text only** — image/audio message parts are dropped.
- **Per-request process spawn** — each call starts a fresh CLI, so expect startup latency.
- **Stateless** — like OpenAI's API, the client sends full history each call; multi-turn
  histories are flattened into a transcript.
- **ToS** — using subscription/free CLIs as a general API backend may be against a
  provider's terms. Fine for personal use; know the risk before pointing real traffic at it.
```
