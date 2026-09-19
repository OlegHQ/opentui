/** Generate the Xi dependency patch from portable FFI and renderer-entry source.
 * Usage: bun scripts/xi-startup-patch.ts /path/to/pristine/@opentui/core [--check]
 * The official 0.5.11 native assets remain unchanged.
 */
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const packageRoot = process.argv[2]
if (!packageRoot) throw new Error("Provide the pristine published @opentui/core directory")
const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"))
if (manifest.name !== "@opentui/core" || manifest.version !== "0.5.11") throw new Error("Expected @opentui/core 0.5.11")
const runtimeSource = await readFile(join(root, "packages/core/src/platform/runtime-text.bun.ts"), "utf8")
const timingSource = await readFile(join(root, "packages/core/src/renderables/TimeToFirstDraw.ts"), "utf8")
const timingInitialization = timingSource.match(/graphemeSegmenter \?\?= .*/)?.[0]
if (!timingInitialization) throw new Error("Missing deferred timing segmenter initialization")
const helperSource = await readFile(join(root, "packages/core/src/platform/lazy-library.ts"), "utf8")
const transpiled = new Bun.Transpiler({ loader: "ts", target: "bun" }).transformSync(helperSource)
const helper = transpiled
  .replace(/^import \{ dlopen \} from "\.\/ffi\.js";?\n/m, "")
  .replace("export function dlopenLazy", "function dlopenLazy")
if (/^import |^export /m.test(helper)) throw new Error("Unexpected helper module boundary")
const materializeSource = await readFile(join(root, "packages/core/src/platform/materialize-library.ts"), "utf8")
const materialize = new Bun.Transpiler({ loader: "ts", target: "bun" })
  .transformSync(materializeSource)
  .replace("export async function materializeLibrary", "async function materializeLibrary")
const temporary = await mkdtemp(join(tmpdir(), "opentui-xi-patch-"))
try {
  const patches: string[] = []
  for (const name of (await readdir(packageRoot)).sort()) {
    if (!/^chunk-.*\.js$/.test(name)) continue
    const original = await readFile(join(packageRoot, name), "utf8")
    const call = "const rawSymbols = dlopen(resolvedLibPath, {"
    if (!original.includes(call)) continue
    if (original.includes("function dlopenLazy")) throw new Error("Input must be pristine")
    const pathCall = "targetLibPath = await resolveNativeLibraryPath();"
    if (!original.includes(pathCall)) throw new Error("Unexpected native path resolver")
    let runtimeUpdated = original
    if (name.startsWith("chunk-bun-")) {
      // Match the source package's runtime condition: Bun never loads Node's
      // private fallback modules. Node retains its original bundled helpers.
      const fallbacks = /\/\/ \.\.\/.*\/ansi-regex\/index\.js\n[\s\S]*?(?=\/\/ src\/platform\/assets\.ts)/
      if (!fallbacks.test(original)) throw new Error("Missing published fallback modules")
      runtimeUpdated = original.replace(fallbacks, "")
      for (const [helper, previous] of [
        ["stringWidth", "stringWidth2"],
        ["stripANSI", "stripAnsi"],
      ]) {
        const expression = runtimeSource.match(new RegExp(`export const ${helper}: .* = (.*)`))?.[1]
        const declaration = `var ${helper} = bun?.${helper} ?? ${previous};`
        if (!expression || !runtimeUpdated.includes(declaration)) throw new Error(`Missing runtime helper ${helper}`)
        runtimeUpdated = runtimeUpdated.replace(declaration, `var ${helper} = ${expression};`)
      }
    }
    const updated =
      runtimeUpdated
        .replace(call, "const rawSymbols = dlopenLazy(resolvedLibPath, {")
        .replace(pathCall, "targetLibPath = await materializeLibrary(await resolveNativeLibraryPath());") +
      "\n" +
      helper +
      "\n" +
      materialize
    const before = join(temporary, "before")
    const after = join(temporary, "after")
    await writeFile(before, original)
    await writeFile(after, updated)
    const diff = Bun.spawn(["diff", "-u", "--label", `a/${name}`, "--label", `b/${name}`, before, after], {
      stdout: "pipe",
      stderr: "inherit",
    })
    const text = await new Response(diff.stdout).text()
    if ((await diff.exited) !== 1) throw new Error("Expected a nonempty dependency patch")
    patches.push(`diff --git a/${name} b/${name}\n${text}`)
  }
  // Both Bun and Node published bundles must consume the same portable fix.
  if (patches.length !== 2) throw new Error(`Expected two runtime chunks, found ${patches.length}`)
  // Re-export the published shared chunks rather than rebundling a second copy
  // of the renderer/native state. Resolve names from the upstream public entry;
  // fail closed if a future package no longer exports a primitive from a chunk.
  const entrySource = await readFile(join(root, "packages/core/src/renderer-entry.ts"), "utf8")
  const exports = new Bun.Transpiler({ loader: "ts" }).scan(entrySource).exports
  for (const runtime of ["bun", "node"]) {
    const index = await readFile(join(packageRoot, `index.${runtime}.js`), "utf8")
    const eagerSegmenter = 'var graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });'
    const segmentLoop = "  for (const { segment } of graphemeSegmenter.segment(text)) {"
    if (!index.includes(eagerSegmenter) || !index.includes(segmentLoop)) throw new Error("Missing timing widget")
    let updatedIndex = index
      .replace(eagerSegmenter, "var graphemeSegmenter;")
      .replace(segmentLoop, `  ${timingInitialization};\n${segmentLoop}`)
    if (runtime === "bun") {
      const parser =
        /\/\/ \.\.\/.*\/marked\/lib\/marked\.esm\.js\n[\s\S]*?(?=\/\/ src\/renderables\/text-table-width\.ts)/
      if (!parser.test(updatedIndex)) throw new Error("Missing bundled Markdown parser")
      const parserBody = updatedIndex.match(parser)![0]
      updatedIndex = updatedIndex.replace(parser, "")
      if ((updatedIndex.match(/x\.lex(?:Inline)?\(/g) ?? []).length !== 4)
        throw new Error("Unexpected Markdown callers")
      updatedIndex = updatedIndex
        .replaceAll("x.lex(", "getMarkdownLexer().lex(")
        .replaceAll("x.lexInline(", "getMarkdownLexer().lexInline(")
      // The published @bun file is already transpiled: bare require is unavailable.
      // Keep its bundled lexer self-contained and initialize it once on first use.
      updatedIndex += `\nvar markdownLexer;\nfunction getMarkdownLexer() {\n  if (markdownLexer) return markdownLexer;\n${parserBody}\n  return markdownLexer = x;\n}\n`
    }
    await addPatch(`index.${runtime}.js`, updatedIndex, true)
    const imports = new Map<string, string>()
    for (const match of index.matchAll(/import\s*\{([^}]+)\}\s*from\s*"(\.\/chunk-[^"]+)"/g)) {
      for (const name of match[1]
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)) {
        if (!/^\w+$/.test(name)) throw new Error(`Unexpected published import: ${name}`)
        imports.set(name, match[2])
      }
    }
    const exportBlock = /export\s*\{([^}]+)\};\s*(?:\/\/[\s\S]*)?$/.exec(index)?.[1]
    if (!exportBlock) throw new Error("Missing published export block")
    const aliases = new Map<string, string>()
    for (const item of exportBlock.split(",")) {
      const [local, exposed = local] = item.trim().split(/\s+as\s+/)
      aliases.set(exposed, local)
    }
    const lines = exports.map((name) => {
      const local = aliases.get(name)
      const chunk = local && imports.get(local)
      if (!chunk) throw new Error(`Renderer export ${name} is not a shared ${runtime} primitive`)
      return `export { ${local} as ${name} } from "${chunk}";`
    })
    await addPatch(runtime === "bun" ? "renderer-entry.bun.js" : "renderer-entry.js", lines.join("\n") + "\n")
  }
  // This source contains only public re-exports, so it is also the declaration.
  await addPatch("renderer-entry.d.ts", entrySource)
  manifest.exports["./renderer"] = {
    types: "./renderer-entry.d.ts",
    bun: "./renderer-entry.bun.js",
    node: "./renderer-entry.js",
    import: "./renderer-entry.js",
  }
  await addPatch("package.json", JSON.stringify(manifest, null, 2) + "\n", true)

  async function addPatch(name: string, updated: string, existing = false): Promise<void> {
    const before = join(temporary, "before")
    const after = join(temporary, "after")
    await writeFile(before, existing ? await readFile(join(packageRoot, name), "utf8") : "")
    await writeFile(after, updated)
    const diff = Bun.spawn(
      ["diff", "-u", "--label", existing ? `a/${name}` : "/dev/null", "--label", `b/${name}`, before, after],
      {
        stdout: "pipe",
        stderr: "inherit",
      },
    )
    const text = await new Response(diff.stdout).text()
    if ((await diff.exited) !== 1) throw new Error(`Expected nonempty patch for ${name}`)
    patches.push(`diff --git a/${name} b/${name}\n${existing ? "" : "new file mode 100644\n"}${text}`)
  }
  const output = join(root, "patches/opentui-core-0.5.11.patch")
  const patch = patches.join("")
  if (process.argv.includes("--check")) {
    if ((await readFile(output, "utf8")) !== patch) throw new Error("Generated patch is stale")
    console.log("Xi startup patch matches fork source")
  } else {
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, patch)
    console.log(output)
  }
} finally {
  await rm(temporary, { recursive: true, force: true })
}
