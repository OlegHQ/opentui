import { pathToFileURL } from "node:url"
import { RGBA } from "../lib/RGBA.js"
import type { NativeContextHandle, SceneNodeHandle } from "../zig.js"

// Run against either checkout: --module=/absolute/path/packages/core/src/zig.ts.
// --legacy supplies complete paint projections, as Renderable did before partial updates.
// --native includes the actual one-admission FFI call; default measures encode + borrow/consume.
const argument = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.split("=")[1]
const modulePath = argument("module")
const { SceneStaging, resolveRenderLib } = await import(modulePath ? pathToFileURL(modulePath).href : "../zig.js")
const legacy = process.argv.includes("--legacy")
const native = process.argv.includes("--native")
const nodes = Number(argument("nodes") ?? 1000)
if (!Number.isInteger(nodes) || nodes < 1 || nodes > Math.floor(SceneStaging.limit / 4)) {
  throw new RangeError("Node count must fit four layout writes per native batch")
}
const frames = 100
const lib = native ? resolveRenderLib() : undefined
const context: NativeContextHandle =
  lib?.createContext({ objectCapacity: nodes + 2, renderCellsMax: 32 }) ?? ({} as NativeContextHandle)
const colors = Array.from({ length: 4 }, (_, index) => RGBA.fromInts(index + 1, 0, 0))
const full = {
  zIndex: 0,
  opacity: 1,
  translateX: 0,
  translateY: 0,
  border: 0,
  shouldFill: true,
  backgroundColor: colors[0],
  borderColor: colors[1],
  focusedBorderColor: colors[2],
  borderStyle: "single",
  focusable: false,
}
let checksum = 0
const scenarios = ["background", "opacity", "mixed", "layout", "full"] as const
try {
  const session = lib?.createSession(context, { chunkSize: 1024, spanCapacity: 2, maxBytes: 2048n })
  if (lib) {
    lib.sessionAttachRenderer(context, session, { width: 8, height: 2, remote: true })
    lib.sceneCreateNode(context, session, "root", 1)
  }
  const handles: SceneNodeHandle[] = Array.from({ length: nodes }, (_, index) =>
    lib
      ? lib.sceneCreateNode(context, session, "box", index + 2)
      : ({ context, contextId: 1n, slot: index + 1, generation: 1 } as SceneNodeHandle),
  )
  for (const scenario of scenarios) {
    const staging = new SceneStaging()
    let records = 0
    let bytes = 0
    const run = () => {
      for (let repeat = 0; repeat < 4; repeat++) {
        for (const handle of handles) {
          if (scenario === "background") staging.stageBackground(context, handle, colors[repeat])
          else if (scenario === "layout") staging.stageStyle(context, handle, 1, 1, 0, 0, repeat, 0)
          else if (scenario === "full") staging.stagePaint(context, handle, full)
          else {
            if (scenario === "mixed") staging.stageBackground(context, handle, colors[repeat])
            const update = { opacity: (repeat + 1) / 4 }
            staging.stagePaint(
              context,
              handle,
              legacy ? { ...full, ...update, backgroundColor: colors[scenario === "mixed" ? repeat : 3] } : update,
            )
          }
        }
      }
      records = legacy ? staging.styleCount + staging.backgroundCount + staging.paintCount : staging.count
      bytes = legacy
        ? staging.styleCount * 40 + staging.backgroundCount * 32 + staging.paintCount * 96
        : staging.byteLength
      checksum += bytes + records
      if (native) lib.sceneFlush(context, staging)
      else {
        staging._views(context)
        staging.consume(records)
      }
    }
    for (let warmup = 0; warmup < 50; warmup++) run()
    const samples: number[] = []
    const cpuSamples: number[] = []
    for (let sample = 0; sample < 9; sample++) {
      const cpu = process.cpuUsage()
      const start = performance.now()
      for (let frame = 0; frame < frames; frame++) run()
      samples.push(((performance.now() - start) * 1000) / frames)
      const usage = process.cpuUsage(cpu)
      cpuSamples.push((usage.user + usage.system) / frames)
    }
    samples.sort((a, b) => a - b)
    cpuSamples.sort((a, b) => a - b)
    const stagingBufferBytes = legacy
      ? ["styles", "backgrounds", "paints"].reduce(
          (bytes, stream) => bytes + Reflect.get(staging, stream).words.byteLength,
          0,
        )
      : Reflect.get(staging, "words").byteLength
    console.log(
      JSON.stringify({
        scenario,
        legacy,
        native,
        nodes,
        writes: nodes * 4 * (scenario === "mixed" ? 2 : 1),
        records,
        bytes,
        stagingBufferBytes,
        usPerBatch: Math.round(samples[4]),
        usRange: [Math.round(samples[0]), Math.round(samples[8])],
        cpuUsPerBatch: Math.round(cpuSamples[4]),
        samples: samples.length,
      }),
    )
  }
  console.log(
    JSON.stringify({
      runtime: {
        bun: process.versions.bun,
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch,
      },
      checksum,
    }),
  )
} finally {
  if (lib) lib.destroyContext(context)
}
