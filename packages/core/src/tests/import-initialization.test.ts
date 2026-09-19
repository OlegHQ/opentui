import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"

test("Bun runtime and unused timing widget do not initialize ICU segmentation", () => {
  const runtime = new URL("../platform/runtime.ts", import.meta.url).href
  const widget = new URL("../renderables/TimeToFirstDraw.ts", import.meta.url).href
  const markdown = new URL("../renderables/Markdown.ts", import.meta.url).href
  const parser = new URL("../renderables/markdown-parser.ts", import.meta.url).href
  const sourceDirectory = new URL("..", import.meta.url).pathname
  const result = spawnSync(
    process.execPath,
    [
      "--eval",
      `
    import assert from "node:assert/strict"
    let constructions = 0
    const NativeSegmenter = Intl.Segmenter
    Intl.Segmenter = class extends NativeSegmenter {
      constructor(...args) { super(...args); constructions++ }
    }
    const runtime = await import(${JSON.stringify(runtime)})
    assert.equal(runtime.stringWidth, Bun.stringWidth)
    assert.equal(runtime.stripANSI, Bun.stripANSI)
    await import(${JSON.stringify(widget)})
    assert.equal(constructions, 0, "Importing unused fallbacks/widgets must not construct ICU segmenters")
    await import(${JSON.stringify(markdown)})
    const { parseMarkdownIncremental } = await import(${JSON.stringify(parser)})
    const parserPath = Bun.resolveSync("marked", ${JSON.stringify(sourceDirectory)})
    assert.equal(require.cache[parserPath], undefined, "Unused Markdown must not initialize its parser")
    assert.equal(parseMarkdownIncremental("# heading", null).tokens[0].type, "heading")
    assert.ok(require.cache[parserPath], "First Markdown use loads the real parser")
    for (const text of ["abc", "é漢", "e\\u0301", "👨‍👩‍👧‍👦", "\\x1b[31mred\\x1b[0m"]) {
      assert.equal(runtime.stringWidth(text), Bun.stringWidth(text))
      assert.equal(runtime.stripANSI(text), Bun.stripANSI(text))
    }
  `,
    ],
    { encoding: "utf8" },
  )
  expect(result.stderr).toBe("")
  expect(result.status).toBe(0)
})
