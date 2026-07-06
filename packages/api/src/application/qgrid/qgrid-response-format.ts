import {
  type QgridContent,
  type QueryInput,
  type QueryOutput,
} from "./qgrid.types";
import {
  CODEX_IMAGE_GENERATION_MODEL,
  resolveImageGenerationOptions,
} from "./qgrid-image-generation";

export const CODEX_IMAGE_GENERATION_TOOL_CONFIG = {
  type: "image_generation",
  outputFormat: "png",
} as const;

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function formatResponseForLog(result: QueryOutput): string {
  return result.content
    .flatMap((item) => {
      if (item.type === "text") return [item.text];
      if (item.type === "image") {
        const alt = escapeHtmlAttribute(item.revisedPrompt ?? "generated image");
        return [`<img src="data:image/png;base64,${item.data}" alt="${alt}" />`];
      }
      return [];
    })
    .filter((part) => part.length > 0)
    .join("\n");
}

export function getImageParts(result: QueryOutput): Extract<QgridContent, { type: "image" }>[] {
  return result.content.filter((item) => item.type === "image");
}

export function formatImagePartForLog(image: Extract<QgridContent, { type: "image" }>): string {
  const alt = escapeHtmlAttribute(image.revisedPrompt ?? "generated image");
  return `<img src="data:image/png;base64,${image.data}" alt="${alt}" />`;
}

export function imageGenerationToolArgs(args: QueryInput): string {
  const resolved = resolveImageGenerationOptions(args.imageGenerationOptions);
  return JSON.stringify({
    prompt: args.prompt,
    driverModel: args.model ?? null,
    tool: CODEX_IMAGE_GENERATION_TOOL_CONFIG,
    pricingAssumption: {
      model: CODEX_IMAGE_GENERATION_MODEL,
      quality: resolved.quality,
      size: resolved.size,
    },
  });
}
