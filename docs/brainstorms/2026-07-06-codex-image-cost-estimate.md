# Codex image_generation cost estimate

qgrid uses Codex's built-in `image_generation` Responses tool, not the OpenAI Images API directly. That means qgrid does not receive the Image API `usage` object that would let it calculate exact text/image input and image output token cost.

Decision:

- Codex currently registers `image_generation` with `output_format: "png"`.
- qgrid logs synthetic tool args with the actual Codex tool config plus a separate pricing assumption so request logs distinguish the driver model, the tool surface, and the cost estimate.
- qgrid stores image output cost separately in `request_logs.image_cost_usd` as a configured estimate.
- Existing `request_logs.cost_usd` remains the Codex driver model token cost for backward compatibility.

Current estimate:

- `assumed:gpt-image-2:medium:1536x1024:png`
- `$0.041` per generated image, stored as `41000` micro-USD.

Supported estimate table:

| Quality | 1024x1024 | 1024x1536 | 1536x1024 |
| --- | ---: | ---: | ---: |
| low | $0.006 | $0.005 | $0.005 |
| medium | $0.053 | $0.041 | $0.041 |
| high | $0.211 | $0.165 | $0.165 |

Why not exact:

- OpenAI's image generation guide provides a cost calculator/table for `gpt-image-2` output cost by quality and size.
- Codex `image_generation_call` currently returns the image result but not the underlying tool usage token breakdown.
- If Codex later exposes tool usage, qgrid should replace this fixed estimate with token-based accounting.
