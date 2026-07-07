import { describe, expect, it } from "vitest";

import { buildImageGenerationToolSteps, imageGenerationToolArgs } from "./qgrid-response-format";

describe("qgrid response log formatting", () => {
  it("includes input images in image-generation tool args", () => {
    expect(
      JSON.parse(
        imageGenerationToolArgs({
          prompt: "stage this room",
          model: "openai/gpt-5.5",
          input: [
            { type: "text", text: "stage this room", text_elements: [] },
            { type: "image", url: "data:image/webp;base64,UklGRg==" },
          ],
        }),
      ),
    ).toMatchObject({
      prompt: "stage this room",
      inputImages: [{ mediaType: "image/webp", data: "UklGRg==", byteSize: 4 }],
    });
  });

  it("can omit input images from later multi-output tool args", () => {
    const args = JSON.parse(
      imageGenerationToolArgs(
        {
          prompt: "stage this room",
          input: [{ type: "image", url: "data:image/webp;base64,UklGRg==" }],
        },
        { includeInputImages: false },
      ),
    );

    expect(args.inputImages).toBeUndefined();
  });

  it("masks non-image data urls that reach input image tool args", () => {
    const args = JSON.parse(
      imageGenerationToolArgs({
        prompt: "stage this room",
        input: [{ type: "image", url: "data:application/pdf;base64,JVBERi0xLjQ=" }],
      }),
    );

    expect(args.inputImages).toEqual([
      {
        mediaType: "application/pdf",
        url: "[data-url 40 chars]",
        byteSize: 8,
      },
    ]);
  });

  it("builds multi-output image-generation tool steps without duplicating input images", () => {
    const steps = buildImageGenerationToolSteps(
      {
        prompt: "stage this room",
        input: [{ type: "image", url: "data:image/webp;base64,UklGRg==" }],
      },
      [
        { type: "image", data: "first", revisedPrompt: "first" },
        { type: "image", data: "second", revisedPrompt: "second" },
      ],
      2,
    );

    expect(JSON.parse(steps[0]!.tool_args).inputImages).toEqual([
      { mediaType: "image/webp", data: "UklGRg==", byteSize: 4 },
    ]);
    expect(JSON.parse(steps[1]!.tool_args).inputImages).toBeUndefined();
    expect(steps.map((step) => step.tool_call_id)).toEqual([
      "image_generation:2:0",
      "image_generation:2:1",
    ]);
  });
});
