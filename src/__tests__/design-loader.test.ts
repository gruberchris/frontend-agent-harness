import { describe, test, expect, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadDesignContent, buildMessageContent } from "../design/design-loader.ts";

// Minimal valid 1×1 white PNG (68 bytes)
const MINIMAL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==";
const MINIMAL_PNG_BYTES = Buffer.from(MINIMAL_PNG_BASE64, "base64");

// Fake JPEG bytes (not a valid image, just enough to test byte loading)
const FAKE_JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

const trackedPaths: string[] = [];

afterEach(async () => {
  for (const p of trackedPaths) {
    await fs.rm(p, { recursive: true, force: true }).catch(() => {});
  }
  trackedPaths.length = 0;
});

async function writeTempDesign(dir: string, content: string): Promise<string> {
  const designPath = path.join(dir, "design.md");
  await Bun.write(designPath, content);
  return designPath;
}

async function makeTempDir(): Promise<string> {
  const dir = `/tmp/design-loader-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await fs.mkdir(dir, { recursive: true });
  trackedPaths.push(dir);
  return dir;
}

// ── loadDesignContent ─────────────────────────────────────────────────────────

describe("loadDesignContent", () => {
  test("returns the full text when there are no image references", async () => {
    const dir = await makeTempDir();
    const content = "# My App\n\nA todo app.\n\nNo images here.";
    const designPath = await writeTempDesign(dir, content);

    const result = await loadDesignContent(designPath);

    expect(result.text).toBe(content);
    expect(result.images).toHaveLength(0);
  });

  test("loads a local PNG image reference and base64-encodes it", async () => {
    const dir = await makeTempDir();
    const imgPath = path.join(dir, "screenshot.png");
    await Bun.write(imgPath, MINIMAL_PNG_BYTES);

    const content = `# Design\n\n![UI screenshot](./screenshot.png)\n\nSome text.`;
    const designPath = await writeTempDesign(dir, content);

    const result = await loadDesignContent(designPath);

    expect(result.text).toBe(content);
    expect(result.images).toHaveLength(1);
    expect(result.images[0]!.mimeType).toBe("image/png");
    expect(result.images[0]!.altText).toBe("UI screenshot");
    expect(result.images[0]!.data).toBe(MINIMAL_PNG_BASE64);
  });

  test("loads a local JPEG image and sets the correct mimeType", async () => {
    const dir = await makeTempDir();
    const imgPath = path.join(dir, "photo.jpg");
    await Bun.write(imgPath, FAKE_JPEG_BYTES);

    const content = `# Design\n\n![Photo](./photo.jpg)`;
    const designPath = await writeTempDesign(dir, content);

    const result = await loadDesignContent(designPath);

    expect(result.images).toHaveLength(1);
    expect(result.images[0]!.mimeType).toBe("image/jpeg");
    expect(result.images[0]!.data).toBe(FAKE_JPEG_BYTES.toString("base64"));
  });

  test("treats .jpeg extension as image/jpeg", async () => {
    const dir = await makeTempDir();
    await Bun.write(path.join(dir, "img.jpeg"), FAKE_JPEG_BYTES);
    const designPath = await writeTempDesign(dir, `# D\n\n![](./img.jpeg)`);

    const result = await loadDesignContent(designPath);
    expect(result.images[0]!.mimeType).toBe("image/jpeg");
  });

  test("skips http:// image references", async () => {
    const dir = await makeTempDir();
    const content = `# Design\n\n![Remote](http://example.com/image.png)`;
    const designPath = await writeTempDesign(dir, content);

    const result = await loadDesignContent(designPath);

    expect(result.images).toHaveLength(0);
  });

  test("skips https:// image references", async () => {
    const dir = await makeTempDir();
    const content = `# Design\n\n![Remote](https://cdn.example.com/screenshot.jpg)`;
    const designPath = await writeTempDesign(dir, content);

    const result = await loadDesignContent(designPath);

    expect(result.images).toHaveLength(0);
  });

  test("skips image references pointing to non-existent files", async () => {
    const dir = await makeTempDir();
    const content = `# Design\n\n![Missing](./does-not-exist.png)`;
    const designPath = await writeTempDesign(dir, content);

    const result = await loadDesignContent(designPath);

    expect(result.images).toHaveLength(0);
  });

  test("skips unsupported image formats (.svg, .bmp, .tiff)", async () => {
    const dir = await makeTempDir();
    await Bun.write(path.join(dir, "icon.svg"), "<svg/>");
    await Bun.write(path.join(dir, "img.bmp"), Buffer.from([0x42, 0x4d]));
    const content = `# D\n\n![](./icon.svg)\n\n![](./img.bmp)`;
    const designPath = await writeTempDesign(dir, content);

    const result = await loadDesignContent(designPath);

    expect(result.images).toHaveLength(0);
  });

  test("loads multiple images in document order", async () => {
    const dir = await makeTempDir();
    await Bun.write(path.join(dir, "first.png"), MINIMAL_PNG_BYTES);
    await Bun.write(path.join(dir, "second.jpg"), FAKE_JPEG_BYTES);
    const content = `# Design\n\n![First](./first.png)\n\nSome text.\n\n![Second](./second.jpg)`;
    const designPath = await writeTempDesign(dir, content);

    const result = await loadDesignContent(designPath);

    expect(result.images).toHaveLength(2);
    expect(result.images[0]!.mimeType).toBe("image/png");
    expect(result.images[0]!.altText).toBe("First");
    expect(result.images[1]!.mimeType).toBe("image/jpeg");
    expect(result.images[1]!.altText).toBe("Second");
  });

  test("resolves image paths relative to the design file's directory, not cwd", async () => {
    const dir = await makeTempDir();
    const subDir = path.join(dir, "assets");
    await fs.mkdir(subDir);
    await Bun.write(path.join(subDir, "img.png"), MINIMAL_PNG_BYTES);

    // design.md is in dir, image is in dir/assets/
    const content = `# D\n\n![](./assets/img.png)`;
    const designPath = await writeTempDesign(dir, content);

    const result = await loadDesignContent(designPath);

    expect(result.images).toHaveLength(1);
    expect(result.images[0]!.mimeType).toBe("image/png");
  });

  test("preserves the original text unchanged in .text property", async () => {
    const dir = await makeTempDir();
    await Bun.write(path.join(dir, "img.png"), MINIMAL_PNG_BYTES);
    const original = `# Design\n\n![](./img.png)\n\nMore content.`;
    const designPath = await writeTempDesign(dir, original);

    const result = await loadDesignContent(designPath);

    // text must be byte-identical to the original file content
    expect(result.text).toBe(original);
  });

  test("handles a mix of local and remote refs, loading only local ones", async () => {
    const dir = await makeTempDir();
    await Bun.write(path.join(dir, "local.png"), MINIMAL_PNG_BYTES);
    const content = `# D\n\n![Remote](https://example.com/r.png)\n\n![Local](./local.png)`;
    const designPath = await writeTempDesign(dir, content);

    const result = await loadDesignContent(designPath);

    expect(result.images).toHaveLength(1);
    expect(result.images[0]!.altText).toBe("Local");
  });
});

// ── buildMessageContent ───────────────────────────────────────────────────────

describe("buildMessageContent", () => {
  test("returns a plain string when images array is empty", () => {
    const result = buildMessageContent("Hello world", []);
    expect(typeof result).toBe("string");
    expect(result).toBe("Hello world");
  });

  test("returns a MessageContentPart[] when images are present", () => {
    const images = [{ altText: "screenshot", data: MINIMAL_PNG_BASE64, mimeType: "image/png" }];
    const result = buildMessageContent("Design doc text", images);

    expect(Array.isArray(result)).toBe(true);
    const parts = result as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    expect(parts).toHaveLength(2);
  });

  test("first part is the prompt text", () => {
    const images = [{ altText: "", data: MINIMAL_PNG_BASE64, mimeType: "image/png" }];
    const parts = buildMessageContent("My prompt", images) as Array<{ type: string; text?: string }>;

    expect(parts[0]!.type).toBe("text");
    expect(parts[0]!.text).toBe("My prompt");
  });

  test("subsequent parts are image content blocks with correct data and mimeType", () => {
    const images = [
      { altText: "img1", data: "aaa", mimeType: "image/png" },
      { altText: "img2", data: "bbb", mimeType: "image/jpeg" },
    ];
    const parts = buildMessageContent("Prompt", images) as Array<{
      type: string;
      data?: string;
      mimeType?: string;
    }>;

    expect(parts).toHaveLength(3);
    expect(parts[1]!).toEqual({ type: "image", data: "aaa", mimeType: "image/png" });
    expect(parts[2]!).toEqual({ type: "image", data: "bbb", mimeType: "image/jpeg" });
  });

  test("does not mutate the images array", () => {
    const images = [{ altText: "x", data: "abc", mimeType: "image/png" }];
    const before = JSON.stringify(images);
    buildMessageContent("prompt", images);
    expect(JSON.stringify(images)).toBe(before);
  });
});
