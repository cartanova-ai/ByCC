import {
  type ImageGenerationOptions,
  type ImageGenerationQuality,
  type ImageGenerationSize,
  type QueryOutput,
} from "./qgrid.types";

export const CODEX_IMAGE_GENERATION_MODEL = "gpt-image-2";
export const DEFAULT_IMAGE_GENERATION_QUALITY: ImageGenerationQuality = "medium";
export const DEFAULT_IMAGE_GENERATION_SIZE: ImageGenerationSize = "1536x1024";

export type ResolvedImageGenerationOptions = {
  quality: ImageGenerationQuality;
  size: ImageGenerationSize;
};

// OpenAI gpt-image-2 image output cost estimates by quality/size:
// https://developers.openai.com/api/docs/guides/image-generation#calculating-costs
const IMAGE_OUTPUT_COST_MICRO_USD: Record<
  ImageGenerationQuality,
  Record<ImageGenerationSize, number>
> = {
  low: {
    "1024x1024": 6_000,
    "1024x1536": 5_000,
    "1536x1024": 5_000,
  },
  medium: {
    "1024x1024": 53_000,
    "1024x1536": 41_000,
    "1536x1024": 41_000,
  },
  high: {
    "1024x1024": 211_000,
    "1024x1536": 165_000,
    "1536x1024": 165_000,
  },
};

export function resolveImageGenerationOptions(
  options: ImageGenerationOptions | undefined,
): ResolvedImageGenerationOptions {
  return {
    quality: options?.quality ?? DEFAULT_IMAGE_GENERATION_QUALITY,
    size: options?.size ?? DEFAULT_IMAGE_GENERATION_SIZE,
  };
}

export function imageGenerationCostMethod(options: ImageGenerationOptions | undefined): string {
  const resolved = resolveImageGenerationOptions(options);
  return `assumed:${CODEX_IMAGE_GENERATION_MODEL}:${resolved.quality}:${resolved.size}:png`;
}

export function estimateImageGenerationCostMicroUsd(
  result: QueryOutput,
  options: ImageGenerationOptions | undefined,
): number | null {
  const imageCount = result.content.filter((item) => item.type === "image").length;
  if (imageCount === 0) return null;
  const resolved = resolveImageGenerationOptions(options);
  return imageCount * IMAGE_OUTPUT_COST_MICRO_USD[resolved.quality][resolved.size];
}
