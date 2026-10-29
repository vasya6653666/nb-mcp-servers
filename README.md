# NeuralBridge MCP servers

MCP servers by NeuralBridge, published to npm under `@neuralbridge`. Each server lives in its own folder under
`packages/` and is the server behind a power of NeuralBridge IDE. Every server also works with any MCP client over stdio.

| Package | Folder | What it does |
|---|---|---|
| [`@neuralbridge/infra-as-code-mcp`](https://www.npmjs.com/package/@neuralbridge/infra-as-code-mcp) | [`packages/infra-as-code`](packages/infra-as-code) | Terraform and OpenTofu: format, validate, plan with a readable summary, apply a reviewed plan |

## Releases

A package is published by pushing a tag `<folder>-v<version>`, for example `infra-as-code-v1.0.0`. The `publish`
workflow builds and tests the package and publishes it to npm with provenance.

## License

Apache-2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
