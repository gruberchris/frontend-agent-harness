import * as path from "node:path";
import type { MessageContentPart } from "../llm/types.ts";

const SUPPORTED_EXTENSIONS: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export interface DesignImage {
  altText: string;
  data: string;    // base64-encoded
  mimeType: string;
}

export interface DesignContent {
  text: string;
  images: DesignImage[];
}

/**
 * Reads a design file, finds all local image references (![alt](path)),
 * loads, and base64-encodes them. HTTP/HTTPS URLs and missing or unsupported
 * files are silently skipped.
 */
export async function loadDesignContent(designFilePath: string): Promise<DesignContent> {
  const text = await Bun.file(designFilePath).text();
  const designDir = path.dirname(path.resolve(designFilePath));
  const images: DesignImage[] = [];

  // Match ![alt text](path) — skip http(s):// URLs
  const imageRefRegex = /!\[(.*?)]\((?!https?:\/\/)([^)]+)\)/g;
  let match: RegExpExecArray | null;

  while ((match = imageRefRegex.exec(text)) !== null) {
    const altText = match[1] ?? "";
    const imagePath = (match[2] ?? "").trim();

    const ext = path.extname(imagePath).toLowerCase();
    const mimeType = SUPPORTED_EXTENSIONS[ext];
    if (!mimeType) continue;

    const absPath = path.isAbsolute(imagePath)
      ? imagePath
      : path.join(designDir, imagePath);

    const file = Bun.file(absPath);
    if (!await file.exists()) continue;

    const buffer = await file.arrayBuffer();
    const data = Buffer.from(buffer).toString("base64");
    images.push({ altText, data, mimeType });
  }

  return { text, images };
}

/**
 * Builds the content value for an LLMMessage from a text prompt and images.
 * Returns a plain string when there are no images (backward-compatible),
 * or a MessageContentPart[] with text first and images appended.
 */
export function buildMessageContent(
  promptText: string,
  images: DesignImage[],
): string | MessageContentPart[] {
  if (images.length === 0) return promptText;
  return [
    { type: "text", text: promptText },
    ...images.map((img) => ({
      type: "image" as const,
      data: img.data,
      mimeType: img.mimeType,
    })),
  ];
}
