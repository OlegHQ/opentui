import { expect, test } from "bun:test"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { materializeLibrary } from "./materialize-library.js"

test("installed native libraries keep their existing path", async () => {
  expect(await materializeLibrary("/installed/libopentui.so")).toBe("/installed/libopentui.so")
  expect(await materializeLibrary("B:\\~BUN\\root\\opentui.dll")).toBe("B:\\~BUN\\root\\opentui.dll")
})

const compiledTest = typeof Bun === "undefined" ? test.skip : test
compiledTest(
  "compiled renderer shares native state across deferred bindings and cleans extraction on exit",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "opentui-compiled-lazy-"))
    try {
      const fixture = join(directory, "fixture.ts")
      const binary = join(directory, process.platform === "win32" ? "fixture.exe" : "fixture")
      const rendererPath = fileURLToPath(new URL("../testing/test-renderer.ts", import.meta.url))
      await writeFile(
        fixture,
        `
import { createTestRenderer } from ${JSON.stringify(rendererPath)}
const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 20, height: 5 })
await renderOnce()
if (captureCharFrame().length === 0) throw new Error("missing native frame")
renderer.destroy()
console.log("compiled native state shared")
`,
      )
      const build = Bun.spawn([process.execPath, "build", "--compile", fixture, "--outfile", binary], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const buildOutput = await new Response(build.stderr).text()
      expect(await build.exited, buildOutput).toBe(0)
      const child = Bun.spawn([binary], {
        cwd: directory,
        env: { ...process.env, TMPDIR: directory, TMP: directory, TEMP: directory, PATH: "", HOME: directory },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(code, stderr).toBe(0)
      expect(stdout).toContain("compiled native state shared")
      expect((await readdir(directory)).filter((name) => name.startsWith("opentui-native-"))).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  30_000,
)
