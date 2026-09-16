/** Generate the Xi Bun patch from the fork's portable FFI source.
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
    const updated =
      original
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
