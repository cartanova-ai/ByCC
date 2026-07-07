import {
  CODEX_IMAGE_GENERATION_MODEL,
  resolveImageGenerationOptions,
} from "./qgrid-image-generation";
import { type QgridContent, type QueryInput, type QueryOutput } from "./qgrid.types";

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

export function imageGenerationToolArgs(
  args: QueryInput,
  options: { includeInputImages?: boolean } = {},
): string {
  const resolved = resolveImageGenerationOptions(args.imageGenerationOptions);
  const inputImages =
    options.includeInputImages === false ? [] : extractInputImagesForToolArgs(args);
  return JSON.stringify({
    prompt: args.prompt,
    ...(inputImages.length > 0 ? { inputImages } : {}),
    driverModel: args.model ?? null,
    tool: CODEX_IMAGE_GENERATION_TOOL_CONFIG,
    pricingAssumption: {
      model: CODEX_IMAGE_GENERATION_MODEL,
      quality: resolved.quality,
      size: resolved.size,
    },
  });
}

export function buildImageGenerationToolSteps(
  args: QueryInput,
  images: Extract<QgridContent, { type: "image" }>[],
  stepIndex: number,
): Array<{
  step_index: number;
  type: "tool_call";
  tool_call_index: number;
  tool_call_id: string;
  tool_name: "image_generation";
  tool_args: string;
  tool_result: string;
}> {
  if (images.length === 0) return [];

  const firstToolArgs = imageGenerationToolArgs(args, { includeInputImages: true });
  const laterToolArgs =
    images.length > 1
      ? imageGenerationToolArgs(args, { includeInputImages: false })
      : firstToolArgs;
  return images.map((image, index) => ({
    step_index: stepIndex,
    type: "tool_call",
    tool_call_index: index,
    tool_call_id: `image_generation:${stepIndex}:${index}`,
    tool_name: "image_generation",
    tool_args: index === 0 ? firstToolArgs : laterToolArgs,
    tool_result: formatImagePartForLog(image),
  }));
}

function extractInputImagesForToolArgs(args: QueryInput): Array<{
  mediaType?: string;
  data?: string;
  url?: string;
  byteSize?: number;
}> {
  const images = args.input?.filter((item) => item.type === "image") ?? [];
  return images.map((image) => {
    const dataUrl = parseDataUrl(image.url);
    if (!dataUrl) return { url: image.url };
    if (dataUrl.isBase64 && dataUrl.mediaType.toLowerCase().startsWith("image/")) {
      return {
        mediaType: dataUrl.mediaType,
        data: dataUrl.data,
        byteSize: base64ByteSize(dataUrl.data),
      };
    }
    return {
      mediaType: dataUrl.mediaType,
      url: `[data-url ${image.url.length} chars]`,
      ...(dataUrl.isBase64 ? { byteSize: base64ByteSize(dataUrl.data) } : {}),
    };
  });
}

function parseDataUrl(
  value: string,
): { mediaType: string; data: string; isBase64: boolean } | null {
  const match = /^data:([^;,]+)((?:;[^,]*)*),(.*)$/is.exec(value);
  if (!match) return null;
  const params = match[2]!.toLowerCase().split(";").filter(Boolean);
  return { mediaType: match[1]!, data: match[3]!, isBase64: params.includes("base64") };
}

function base64ByteSize(value: string): number {
  const normalized = /\s/.test(value) ? value.replace(/\s/g, "") : value;
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return Math.max(Math.floor((normalized.length * 3) / 4) - padding, 0);
}
