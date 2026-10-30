# @neuralbridge/local-models-mcp
MCP server for language models the user already runs on their own machine (or their own server): **Ollama** and
**llama-server** from llama.cpp. It talks to them only over their HTTP APIs. It starts no process and installs nothing;
the only thing it can download is an Ollama model, and only through a plan the user has approved.
## Tools
| Tool | What it does | Changes |
|---|---|---|
| `lm_detect` | Whether Ollama (`GET /api/version`) and llama-server (`GET /health`, `GET /props`) answer; versions, loaded llama-server model, context per slot, slots; local or remote address | nothing |
| `lm_list_models` | Ollama models on disk (`GET /api/tags`: size, family, parameters, quantization, date) and in memory (`GET /api/ps`: size, VRAM share, unload time); llama-server `GET /v1/models` and `/props` | nothing |
| `lm_show_model` | Ollama `POST /api/show`: details, context length from `model_info`, capabilities, parameters, start of template and system prompt, first lines of the license | nothing |
| `lm_chat` | One non-streaming request: Ollama `POST /api/chat`, or the llama-server chat completions endpoint (`/v1/chat/completions`); answer plus a metrics line | nothing on disk; Ollama may load the model into memory |
| `lm_embed` | Ollama `POST /api/embed` or llama-server `POST /v1/embeddings`; per vector: dimension, norm, first 8 numbers (`full: true` for whole vectors, truncated if long) | nothing on disk; Ollama may load the model into memory |
| `lm_pull_plan` | Checks Ollama and whether the model is already present; saves a plan | a plan file in the data folder |
| `lm_pull_apply` | `POST /api/pull` of exactly the planned model, waits until done (up to 2 hours), sends progress notifications | **downloads a model** (often several GB) |
| `lm_delete_plan` | Shows the model's size, modification date and digest; saves a plan | a plan file in the data folder |
| `lm_delete_apply` | `DELETE /api/delete` of exactly the planned model, if its digest is unchanged | **deletes a model from disk** |
| `lm_unload` | Frees memory: empty `POST /api/generate` with `keep_alive: 0`; does nothing if the model is not loaded | Ollama memory only |
`lm_pull_apply` and `lm_delete_apply` accept only a plan id. Before running they check that the plan was made for the
same Ollama address and, for deletion, that the model digest has not changed; the plan is then removed, so each plan is
used once. Plans expire after 24 hours.
Ollama does not report the download size before a pull starts, so the plan says "unknown" and the server does not check
free disk space. Ollama resumes interrupted downloads when the same model is pulled again.
## Configuration
| Variable | Default | Meaning |
|---|---|---|
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama address. Same format as Ollama itself: `host`, `host:port` (port 11434 if omitted) or a full `http(s)://` URL. A listen address `0.0.0.0` is contacted as `127.0.0.1`. `user:password@` in the URL is sent as Basic auth. |
| `NB_LLAMACPP_URL` | `http://127.0.0.1:8080` | llama-server address. |
| `NB_LLAMACPP_API_KEY` | — | The key llama-server was started with (`--api-key`), sent as `Authorization: Bearer`. |
| `NB_LM_TIMEOUT_MS` | `120000` | Timeout of a generation or embedding request, at most 1800000 (30 minutes). Service requests use at most 30 s; a pull waits up to 2 hours. |
| `PLUGIN_DATA` | system temp folder + `nb-local-models` | Where plans are kept (`plans/`, folder mode 0700, files 0600). |
Addresses that are not loopback are allowed and marked "remote" in `lm_detect`; requests then leave the machine.
API keys and passwords are never shown: addresses are printed without them (`user:***@`), and error texts are cleaned of
key values and bearer tokens. Logs go to stderr only.
## Server notes
- Ollama: `lm_embed` needs a version with `/api/embed` (older ones have only the deprecated `/api/embeddings`); `capabilities` in `lm_show_model` and `context_length`
  in `/api/ps` appear only in newer versions and are shown when present.
- llama-server: `/health` answers 503 while the model is loading. `/v1/embeddings` works only if the server was started
  with `--embeddings` and an embedding model. JSON output uses `response_format` `{"type": "json_object"}`, and a JSON
  schema is passed as `{"type": "json_object", "schema": …}`. In multi-model (router) mode, pass `model` to `lm_chat`.
## Run
```bash
npx -y @neuralbridge/local-models-mcp@1.0.0
```
Requires Node.js 20.3+ (uses `AbortSignal.any`).
## Develop
```bash
npm install
npm test   # build + unit and end-to-end tests against fake Ollama and llama-server HTTP services
```
## License
Apache-2.0. See `LICENSE` and `NOTICE`.
