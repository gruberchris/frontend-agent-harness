import * as path from "node:path";
import * as fs from "node:fs/promises";

export interface BrokenReference {
  /** File that contains the broken reference, relative to appDir */
  inFile: string;
  /** File that was referenced but doesn't exist, relative to appDir */
  missingFile: string;
}

const SKIP_DIRS = ["node_modules", "dist"];
const TS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

function shouldSkip(relPath: string): boolean {
  return SKIP_DIRS.some((d) => relPath.startsWith(d + "/") || relPath === d);
}

/**
 * Try to resolve a relative import path to an existing file,
 * applying the same extension-resolution rules that TypeScript/bundlers use.
 */
async function resolveRelativeImport(importPath: string, fromDir: string): Promise<boolean> {
  const exact = path.join(fromDir, importPath);
  if (await Bun.file(exact).exists()) return true;

  // No extension — try adding common TS/JS extensions and index files
  if (!path.extname(importPath)) {
    for (const ext of TS_EXTENSIONS) {
      if (await Bun.file(exact + ext).exists()) return true;
    }
    for (const ext of TS_EXTENSIONS) {
      if (await Bun.file(path.join(exact, "index" + ext)).exists()) return true;
    }
  }

  return false;
}

/**
 * Scans the app directory for broken local file references:
 * - HTML files: `src` and `href` attributes pointing at missing local files
 * - TS/JS/JSX/TSX files: relative `import` / `from` paths that can't be resolved
 * - CSS files: `@import` paths pointing at missing local files
 *
 * Ignores `node_modules/` and `dist/`.
 */
export async function findBrokenReferences(appDir: string): Promise<BrokenReference[]> {
  // Bail out gracefully if the directory doesn't exist yet
  try {
    await fs.access(appDir);
  } catch {
    return [];
  }

  const results: BrokenReference[] = [];
  const seen = new Set<string>();

  function add(inFile: string, missingFile: string) {
    const key = `${inFile}::${missingFile}`;
    if (!seen.has(key)) {
      seen.add(key);
      results.push({ inFile, missingFile });
    }
  }

  // ── 1. HTML files ──────────────────────────────────────────────────────────
  const htmlGlob = new Bun.Glob("**/*.html");
  for await (const htmlRel of htmlGlob.scan({ cwd: appDir })) {
    if (shouldSkip(htmlRel)) continue;
    const content = await Bun.file(path.join(appDir, htmlRel)).text().catch(() => "");
    const fromDir = path.join(appDir, path.dirname(htmlRel));

    for (const m of content.matchAll(/(?:src|href)=["']([^"'#?]+)["']/g)) {
      const ref = m[1]!;
      if (ref.startsWith("http") || ref.startsWith("//") || ref.startsWith("data:")) continue;
      const cleanRef = ref.split("?")[0]!.split("#")[0]!;
      if (!cleanRef || cleanRef === "/") continue;

      const absRef = cleanRef.startsWith("/")
        ? path.join(appDir, cleanRef)
        : path.join(fromDir, cleanRef);

      if (!(await Bun.file(absRef).exists())) {
        add(htmlRel, path.relative(appDir, absRef));
      }
    }
  }

  // ── 2. TS/JS/JSX/TSX files ─────────────────────────────────────────────────
  const tsGlob = new Bun.Glob("**/*.{ts,tsx,js,jsx}");
  for await (const tsRel of tsGlob.scan({ cwd: appDir })) {
    if (shouldSkip(tsRel)) continue;
    const content = await Bun.file(path.join(appDir, tsRel)).text().catch(() => "");
    const fromDir = path.join(appDir, path.dirname(tsRel));

    // Match: import ... from './x', import './x', require('./x')
    for (const m of content.matchAll(/(?:from|import|require)\s*\(?['"](\.[^'"]+)['"]/gm)) {
      const ref = m[1]!;
      const resolved = await resolveRelativeImport(ref, fromDir);
      if (!resolved) {
        const importerExt = path.extname(tsRel);
        const defaultExt =
          importerExt === ".tsx" ? ".tsx" :
          importerExt === ".jsx" ? ".jsx" :
          ".ts";
        const guessed = path.extname(ref) ? ref : ref + defaultExt;
        add(tsRel, path.relative(appDir, path.join(fromDir, guessed)));
      }
    }
  }

  // ── 3. CSS files: @import ──────────────────────────────────────────────────
  const cssGlob = new Bun.Glob("**/*.css");
  for await (const cssRel of cssGlob.scan({ cwd: appDir })) {
    if (shouldSkip(cssRel)) continue;
    const content = await Bun.file(path.join(appDir, cssRel)).text().catch(() => "");
    const fromDir = path.join(appDir, path.dirname(cssRel));

    // @import './path.css' or @import url('./path.css')
    for (const m of content.matchAll(/@import\s+(?:url\()?['"]([^'"]+)['"]/g)) {
      const ref = m[1]!;
      if (ref.startsWith("http") || ref.startsWith("//")) continue;
      if (!ref.startsWith(".")) continue; // skip bare specifiers (e.g. normalize.css)

      const absRef = path.join(fromDir, ref);
      if (!(await Bun.file(absRef).exists())) {
        add(cssRel, path.relative(appDir, absRef));
      }
    }
  }

  return results;
}
