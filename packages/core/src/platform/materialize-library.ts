/**
 * Bun's executable filesystem dlopen creates an independent native image on
 * each call. Deferred symbol handles must instead open one physical file so
 * all bindings share renderer handles and native global state.
 *
 * Normal installations do no IO here. Compiled executables extract once into a
 * private process-owned directory; orderly exit removes it after native users.
 */
export async function materializeLibrary(path: string): Promise<string> {
  if (!path.includes("$bunfs") || /^B:[\\/]~BUN/i.test(path)) return path
  path = path.replace("../", "")
  const { mkdtemp, readFile, writeFile, rm } = await import("node:fs/promises")
  const { rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { basename, join } = await import("node:path")
  const directory = await mkdtemp(join(tmpdir(), "opentui-native-"))
  try {
    const destination = join(directory, basename(path))
    await writeFile(destination, await readFile(path), { flag: "wx", mode: 0o600 })
    process.once("exit", () => {
      rmSync(directory, { recursive: true, force: true })
    })
    return destination
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}
