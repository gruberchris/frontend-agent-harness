import { describe, test, expect, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import { findBrokenReferences } from "../validation/reference-checker.ts";

const trackedDirs: string[] = [];

afterEach(async () => {
  for (const d of trackedDirs) {
    await fs.rm(d, { force: true, recursive: true }).catch(() => {});
  }
  trackedDirs.length = 0;
});

async function makeApp(files: Record<string, string>): Promise<string> {
  const dir = `/tmp/ref-check-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  trackedDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = `${dir}/${rel}`;
    await fs.mkdir(abs.substring(0, abs.lastIndexOf("/")), { recursive: true });
    await Bun.write(abs, content);
  }
  return dir;
}

// Paths used in tests. Stored in variables so the IDE does not try to resolve
// them statically — these paths only exist inside runtime temp directories.
const P = {
  mainTsx: "./src/main.tsx",
  globalCss: "./src/styles/global.css",
  missingJs: "./missing.js",
  srcGlobalCss: "./src/global.css",
  tokensCss: "./tokens.css",
} as const;

describe("findBrokenReferences", () => {
  test("returns empty array when all references exist", async () => {
    const dir = await makeApp({
      "index.html": `<html lang="en"><body><script type="module" src="${P.mainTsx}"></script></body></html>`,
      "src/main.tsx": `console.log("hello");`,
    });
    const refs = await findBrokenReferences(dir);
    expect(refs).toHaveLength(0);
  });

  test("detects missing script src in index.html", async () => {
    const dir = await makeApp({
      "index.html": `<html lang="en"><body><script type="module" src="${P.mainTsx}"></script></body></html>`,
      // src/main.tsx intentionally absent
    });
    const refs = await findBrokenReferences(dir);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.inFile).toBe("index.html");
    expect(refs[0]!.missingFile).toBe("src/main.tsx");
  });

  test("detects missing link href in index.html", async () => {
    const dir = await makeApp({
      "index.html": `<html lang="en"><head><link rel="stylesheet" href="${P.globalCss}"/></head></html>`,
      // stylesheet absent
    });
    const refs = await findBrokenReferences(dir);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.missingFile).toBe("src/styles/global.css");
  });

  test("ignores absolute URLs in HTML attributes", async () => {
    const dir = await makeApp({
      "index.html": `<html lang="en"><head><link href="https://fonts.googleapis.com/css?family=Roboto"/></head></html>`,
    });
    const refs = await findBrokenReferences(dir);
    expect(refs).toHaveLength(0);
  });

  test("detects missing relative import in TS file", async () => {
    const dir = await makeApp({
      "src/main.tsx": `import { helper } from "./utils/helper";`,
      // utils/helper.ts absent
    });
    const refs = await findBrokenReferences(dir);
    expect(refs.some((r) => r.missingFile.includes("helper"))).toBe(true);
    expect(refs[0]!.inFile).toBe("src/main.tsx");
  });

  test("resolves extensionless TS import when file exists with .ts extension", async () => {
    const dir = await makeApp({
      "src/main.tsx": `import { helper } from "./utils/helper";`,
      "src/utils/helper.ts": `export const helper = () => {};`,
    });
    const refs = await findBrokenReferences(dir);
    expect(refs).toHaveLength(0);
  });

  test("resolves extensionless import to index.ts in a directory", async () => {
    const dir = await makeApp({
      "src/main.tsx": `import { x } from "./components";`,
      "src/components/index.ts": `export const x = 1;`,
    });
    const refs = await findBrokenReferences(dir);
    expect(refs).toHaveLength(0);
  });

  test("detects missing CSS @import", async () => {
    const dir = await makeApp({
      "src/styles/global.css": `@import '${P.tokensCss}';`,
      // tokens.css absent
    });
    const refs = await findBrokenReferences(dir);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.inFile).toBe("src/styles/global.css");
    expect(refs[0]!.missingFile).toBe("src/styles/tokens.css");
  });

  test("ignores bare CSS @import specifiers (e.g. CDN)", async () => {
    const dir = await makeApp({
      "src/styles/global.css": `@import 'normalize.css';`,
    });
    const refs = await findBrokenReferences(dir);
    expect(refs).toHaveLength(0);
  });

  test("does not scan node_modules", async () => {
    const dir = await makeApp({
      "node_modules/some-pkg/index.html": `<script src="${P.missingJs}"></script>`,
    });
    const refs = await findBrokenReferences(dir);
    expect(refs).toHaveLength(0);
  });

  test("deduplicates identical broken references", async () => {
    // Two HTML files referencing the same missing stylesheet
    const dir = await makeApp({
      "index.html": `<link href="${P.srcGlobalCss}"/>`,
      "other.html": `<link href="${P.srcGlobalCss}"/>`,
    });
    const refs = await findBrokenReferences(dir);
    // Should appear twice (once per referencing file), but not duplicated within the same referencing file
    const distinctKeys = new Set(refs.map((r) => `${r.inFile}::${r.missingFile}`));
    expect(distinctKeys.size).toBe(refs.length);
  });
});
