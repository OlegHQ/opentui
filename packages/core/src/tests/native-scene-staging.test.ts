import { spyOn, test } from "bun:test"
import assert from "node:assert/strict"
import { RGBA } from "../lib/RGBA.js"
import { nativeConstants as c, nativeLayouts, nativeStyleEnumMaxima } from "../native-abi.generated.js"
import { toArrayBuffer } from "../platform/ffi.js"
import {
  NATIVE_SCENE_MUTATIONS_MAX,
  NativeError,
  NativeStatus,
  SceneStaging,
  resolveRenderLib,
  type NativeScenePaint,
} from "../zig.js"

const lib = resolveRenderLib()

test("partial paint retains accepted fields and coalesces into a compact record", () => {
  const { context, session, root, node } = setup()
  try {
    const staging = new SceneStaging(1)
    staging.stageStyle(context, node, 4, 0, 0, 1, 1, 0)
    staging.stageStyle(context, node, 4, 1, 0, 1, 1, 0)
    staging.stagePaint(context, node, paint({ backgroundColor: RGBA.fromInts(90, 0, 0) }))
    lib.sceneFlush(context, staging)
    staging.stagePaint(context, node, { opacity: 1 })
    staging.stagePaint(context, node, { zIndex: 2 })
    assert.equal(staging.count, 1)
    assert.equal(staging.byteLength, 32)
    lib.sceneFlush(context, staging)
    // A sparse mask can still round up to 88 bytes; length alone does not mean full paint.
    staging.stagePaint(context, node, { ...paint({ backgroundColor: RGBA.fromInts(90, 0, 0) }), zIndex: undefined })
    assert.equal(staging.byteLength, 88)
    lib.sceneFlush(context, staging)
    const frame = lib.sceneFrameStep(context, session, null, {
      background: RGBA.fromInts(0, 0, 0),
      useMouse: false,
      excludedHitNum: 0,
      maxLayoutRounds: 8,
      maxHostRequests: 64,
    })
    const lease = lib.sceneFrameAcquireBufferLease(context, session, frame, "next")
    try {
      assert.deepEqual([...new Uint16Array(toArrayBuffer(lease.bg, 0, 8))], [90, 0, 0, 255])
    } finally {
      lib.contextReleaseBufferLease(context, lease.handle)
      lib.sceneFrameCancel(context, session, frame.frameId)
    }
    void root
  } finally {
    lib.destroyContext(context)
  }
})

test("mixed property prefix retry preserves first-touch order and coalesced suffix", () => {
  const { context, session, node, root } = setup()
  try {
    const staging = new SceneStaging(1)
    const stale = { ...node, generation: node.generation + 1 }
    staging.stagePaint(context, root, { opacity: 0.5 })
    staging.stageStyle(context, stale, 4, 0, 0, 1, 99, 0)
    staging.stageStyle(context, node, 4, 0, 0, 1, 6, 0)
    staging.stagePaint(context, node, { backgroundColor: RGBA.fromInts(3, 0, 0) })
    staging.stagePaint(context, node, { translateX: 2, borderColor: RGBA.fromInts(4, 0, 0) })
    assert.throws(() => lib.sceneFlush(context, staging), /after 1 of 4 staged entries/)
    assert.equal(staging.count, 3)
    assert.notEqual(lib.sceneGetStyle(context, node, 4, 0, 0).value, 6)
    staging.discard(stale)
    staging.stagePaint(context, node, { opacity: 1 })
    staging.stagePaint(context, root, { opacity: 1 })
    lib.sceneFlush(context, staging)
    assert.equal(lib.sceneGetStyle(context, node, 4, 0, 0).value, 6)
    assert.equal(staging.count, 0)
    const frame = lib.sceneFrameStep(context, session, null, {
      background: RGBA.fromInts(0, 0, 0),
      useMouse: false,
      excludedHitNum: 0,
      maxLayoutRounds: 8,
      maxHostRequests: 64,
    })
    const lease = lib.sceneFrameAcquireBufferLease(context, session, frame, "next")
    try {
      assert.deepEqual([...new Uint16Array(toArrayBuffer(lease.bg, 2 * 8, 8))], [3, 0, 0, 255])
    } finally {
      lib.contextReleaseBufferLease(context, lease.handle)
      lib.sceneFrameCancel(context, session, frame.frameId)
    }
  } finally {
    lib.destroyContext(context)
  }
})

function paint(overrides: Partial<NativeScenePaint> = {}): NativeScenePaint {
  return {
    zIndex: 0,
    opacity: 1,
    translateX: 0,
    translateY: 0,
    border: 0,
    shouldFill: true,
    backgroundColor: RGBA.fromInts(1, 2, 3),
    borderColor: RGBA.fromInts(4, 5, 6),
    borderStyle: "single",
    focusable: false,
    focusedBorderColor: RGBA.fromInts(7, 8, 9),
    ...overrides,
  }
}

function setup(capacity = 4) {
  const context = lib.createContext({ objectCapacity: capacity, renderCellsMax: 32 })
  const session = lib.createSession(context, { chunkSize: 1024, spanCapacity: 2, maxBytes: 2048n })
  lib.sessionAttachRenderer(context, session, { width: 8, height: 2, remote: true })
  const root = lib.sceneCreateNode(context, session, "root", 1)
  const node = lib.sceneCreateNode(context, session, "box", 2)
  lib.sceneMoveNode(context, node, root, 0)
  return { context, session, root, node }
}

function symbols() {
  return (lib as any).opentui.symbols as Record<string, (...args: unknown[]) => number>
}

test("staging enum boundaries match the checked scene vocabulary", () => {
  const { context, node } = setup()
  try {
    const staging = new SceneStaging()
    for (const [kind, maximum] of nativeStyleEnumMaxima.entries()) {
      staging.stageStyle(context, node, c.OT_STYLE_ENUM, kind, c.OT_EDGE_NONE, c.OT_UNIT_UNDEFINED, maximum, 0)
      lib.sceneFlush(context, staging)
      assert.equal(lib.sceneGetStyle(context, node, c.OT_STYLE_ENUM, kind, c.OT_EDGE_NONE).value, maximum)
      assert.throws(
        () =>
          staging.stageStyle(context, node, c.OT_STYLE_ENUM, kind, c.OT_EDGE_NONE, c.OT_UNIT_UNDEFINED, maximum + 1, 0),
        NativeError,
      )
      assert.equal(staging.styleCount, 0)
    }
  } finally {
    lib.destroyContext(context)
  }
})

test("staging encodes every entry kind and applies them in one native admission", () => {
  const { context, node } = setup()
  const flush = spyOn(symbols(), "ot_scene_flush")
  try {
    const staging = new SceneStaging(2)
    staging.stageStyle(context, node, 4, 0, 0, 1, 5, 0)
    staging.stageStyle(context, node, 4, 1, 0, 1, 2, 0)
    staging.stageStyle(context, node, 1, 0, 0, 0, 3, 0)
    staging.stagePaint(context, node, paint({ zIndex: 7 }))
    assert.equal(staging.count, 4)
    assert.equal(staging.byteLength, 3 * 40 + 88)
    assert.ok(staging.pending)
    lib.sceneFlush(context, staging)
    assert.ok(!staging.pending)
    assert.equal(flush.mock.calls.length, 1)
    assert.equal(lib.sceneGetStyle(context, node, 4, 0, 0).value, 5)
    assert.equal(lib.sceneGetStyle(context, node, 4, 1, 0).value, 2)
    assert.equal(lib.sceneGetStyle(context, node, 1, 0, 0).value, 3)
    // An empty flush never crosses the boundary.
    lib.sceneFlush(context, staging)
    assert.equal(flush.mock.calls.length, 1)
  } finally {
    flush.mockRestore()
    lib.destroyContext(context)
  }
})

test("staging keeps one live background or paint entry per node", () => {
  const { context, session, node, root } = setup()
  try {
    const staging = new SceneStaging()
    staging.stageStyle(context, node, 4, 0, 0, 1, 1, 0)
    staging.stageStyle(context, node, 4, 1, 0, 1, 1, 0)
    // Repeated backgrounds coalesce into one entry.
    staging.stageBackground(context, node, RGBA.fromInts(10, 0, 0))
    staging.stageBackground(context, node, RGBA.fromInts(20, 0, 0))
    assert.equal(staging.count, 3)
    // A later full paint merges into the same first-touch record.
    staging.stagePaint(context, node, paint({ backgroundColor: RGBA.fromInts(30, 0, 0) }))
    assert.equal(staging.count, 3)
    // A background after a staged paint patches that paint in place.
    staging.stageBackground(context, node, RGBA.fromInts(40, 0, 0))
    assert.equal(staging.count, 3)
    // Other nodes stay independent.
    staging.stageBackground(context, root, RGBA.fromInts(50, 0, 0))
    assert.equal(staging.count, 4)
    // Native accepts layout, patched paint, and root background in stream order.
    lib.sceneFlush(context, staging)
    assert.ok(!staging.pending)
    const frame = lib.sceneFrameStep(context, session, null, {
      background: RGBA.fromInts(0, 0, 0),
      useMouse: false,
      excludedHitNum: 0,
      maxLayoutRounds: 8,
      maxHostRequests: 64,
    })
    const lease = lib.sceneFrameAcquireBufferLease(context, session, frame, "next")
    try {
      const bg = new Uint16Array(toArrayBuffer(lease.bg, 0, 8))
      assert.deepEqual([...bg], [40, 0, 0, 255])
    } finally {
      lib.contextReleaseBufferLease(context, lease.handle)
    }
    lib.sceneFrameCancel(context, session, frame.frameId)
  } finally {
    lib.destroyContext(context)
  }
})

test("staging validates inputs before touching any stream", () => {
  const { context, node, session } = setup()
  try {
    const staging = new SceneStaging()
    staging.stageStyle(context, node, 4, 0, 0, 1, 1, 0)
    const before = staging.count
    // Native admission rules are enforced synchronously, mirroring context.zig sceneSetStyle.
    for (const [group, kind, edge, unit, value, flags] of [
      [3, 0, 0, 1, 1, 0],
      [5, 0, 0, 0, 0, 0],
      [0, 0, 1, 0, 0, 0],
      [0, 9, 0, 0, 2, 0],
      [4, 0, 1, 1, 1, 0],
      [2, 0, 0, 1, 1, 1],
      [0, 0, 0, 0, 0, 2],
    ] as const) {
      assert.throws(
        () => staging.stageStyle(context, node, group, kind, edge, unit, value, flags),
        (error: unknown) => error instanceof NativeError && error.status === NativeStatus.InvalidArgument,
      )
    }
    assert.throws(() => staging.stageStyle(context, node, 4, 0, 0, 1, Infinity, 0), RangeError)
    assert.throws(() => staging.stageStyle(context, node, 0, 0, 0, 0, 1.5, 0), RangeError)
    assert.equal(staging.count, before)
    const invalidColor = RGBA.fromInts(0, 0, 0)
    invalidColor.buffer[3] = 256
    assert.throws(() => staging.stageBackground(context, node, invalidColor), /RGBA channels|color intent/)
    assert.equal(staging.count, before)
    assert.throws(() => staging.stagePaint(context, node, paint({ opacity: 2 })), RangeError)
    assert.throws(() => staging.stagePaint(context, node, paint({ border: 16 })), RangeError)
    assert.throws(() => staging.stagePaint(context, node, paint({ zIndex: 1.5 })), RangeError)
    assert.equal(staging.count, before)
    // Handles from a different context are rejected before encoding.
    const other = lib.createContext({ objectCapacity: 2, renderCellsMax: 8 })
    try {
      assert.throws(
        () => staging.stageStyle(other, node, 4, 0, 0, 1, 1, 0),
        (error: unknown) => error instanceof NativeError && error.status === NativeStatus.WrongContext,
      )
    } finally {
      lib.destroyContext(other)
    }
    assert.equal(staging.count, before)
    // The valid prefix still applies.
    lib.sceneFlush(context, staging)
    assert.equal(lib.sceneGetStyle(context, node, 4, 0, 0).value, 1)
    void session
  } finally {
    lib.destroyContext(context)
  }
})

test("staging reentry from caller getters cannot leave a half-written entry", () => {
  const { context, node, root } = setup()
  try {
    const staging = new SceneStaging()
    const nested = paint({ zIndex: 2 })
    let reentered = 0
    Object.defineProperty(nested, "opacity", {
      get() {
        if (reentered++ === 0) {
          staging.stagePaint(context, root, paint({ zIndex: 9 }))
          staging.stageBackground(context, node, RGBA.fromInts(99, 0, 0))
        }
        return 1
      },
    })
    staging.stagePaint(context, node, nested)
    // The outer paint merges into the background reserved by its getter.
    assert.equal(staging.count, 2)
    lib.sceneFlush(context, staging)
    const failing = paint({ zIndex: 3 })
    Object.defineProperty(failing, "translateX", {
      get() {
        staging.stageStyle(context, node, 4, 0, 0, 1, 4, 0)
        return Infinity
      },
    })
    assert.throws(() => staging.stagePaint(context, node, failing), RangeError)
    assert.equal(staging.count, 1)
    lib.sceneFlush(context, staging)
    assert.equal(lib.sceneGetStyle(context, node, 4, 0, 0).value, 4)
  } finally {
    lib.destroyContext(context)
  }
})

test("staging streams grow to the native limit and refuse to exceed it", () => {
  const { context, node } = setup()
  const flush = spyOn(symbols(), "ot_scene_flush")
  try {
    const staging = new SceneStaging(1)
    for (let index = 0; index < NATIVE_SCENE_MUTATIONS_MAX; index++) {
      staging.stageStyle(context, node, 4, 0, 0, 1, index + 1, 0)
    }
    assert.ok(staging.full)
    assert.throws(
      () => staging.stageStyle(context, node, 4, 0, 0, 1, 1, 0),
      (error: unknown) => error instanceof NativeError && error.status === NativeStatus.ObjectLimit,
    )
    lib.sceneFlush(context, staging)
    assert.equal(flush.mock.calls.length, 1)
    assert.equal(flush.mock.calls[0][2], NATIVE_SCENE_MUTATIONS_MAX * 40)
    assert.equal(lib.sceneGetStyle(context, node, 4, 0, 0).value, NATIVE_SCENE_MUTATIONS_MAX)
    assert.ok(!staging.full)
    assert.throws(() => new SceneStaging(0), RangeError)
    assert.throws(() => new SceneStaging(NATIVE_SCENE_MUTATIONS_MAX + 1), RangeError)
  } finally {
    flush.mockRestore()
    lib.destroyContext(context)
  }
})

test("flush retains rejected entries until retry or explicit disposal", () => {
  const { context, node } = setup()
  try {
    const staging = new SceneStaging()
    staging.stageStyle(context, node, 4, 0, 0, 1, 6, 0)
    // Stale raw handles cannot be repaired by retry; their owner must discard them.
    staging.stageStyle(context, { ...node, generation: node.generation + 1 }, 4, 1, 0, 1, 3, 0)
    staging.stageStyle(context, node, 4, 0, 0, 1, 8, 0)
    assert.throws(
      () => lib.sceneFlush(context, staging),
      (error: unknown) =>
        error instanceof NativeError &&
        error.status === NativeStatus.StaleHandle &&
        /after 1 of 3 staged entries/.test(error.message),
    )
    assert.ok(staging.pending)
    assert.equal(staging.count, 2)
    assert.equal(lib.sceneGetStyle(context, node, 4, 0, 0).value, 6)
    staging.discard({ ...node, generation: node.generation + 1 })
    assert.equal(staging.count, 1)
    // The remaining suffix still applies, followed by later writes.
    staging.stageStyle(context, node, 4, 0, 0, 1, 9, 0)
    lib.sceneFlush(context, staging)
    assert.equal(lib.sceneGetStyle(context, node, 4, 0, 0).value, 9)
  } finally {
    lib.destroyContext(context)
  }
})

test("staged style validation matches checked Yoga admission", () => {
  const { context, node } = setup()
  try {
    const staging = new SceneStaging()
    // Call checked native admission directly so this oracle does not reuse staging validation.
    const pointer = Reflect.get(lib, "nativeContexts").get(context)
    assert.ok(pointer)
    const layout = nativeLayouts.ot_handle
    const handle = new BigUint64Array(layout.size / 8)
    const words = new Uint32Array(handle.buffer)
    handle[layout.fields.context_id.offset / 8] = node.contextId
    words[layout.fields.slot.offset / 4] = node.slot
    words[layout.fields.generation.offset / 4] = node.generation
    const values = [0, 1, 2, 3, 5, 8, 9]
    for (const group of [0, 1, 2, 3, 4, 5]) {
      for (const kind of [0, 1, 3, 6, 7, 8, 9, 10, 11]) {
        for (const edge of [0, 3, 9]) {
          for (const unit of [0, 1, 2, 3, 4]) {
            for (const value of values) {
              const status = symbols().ot_scene_set_style(pointer, handle, group, kind, edge, unit, value, 0)
              assert.ok(status === NativeStatus.Ok || status === NativeStatus.InvalidArgument)
              let stagedError: unknown
              try {
                staging.stageStyle(context, node, group, kind, edge, unit, value, 0)
              } catch (error) {
                stagedError = error
              }
              assert.equal(
                Boolean(stagedError),
                status !== NativeStatus.Ok,
                JSON.stringify({ group, kind, edge, unit, value }),
              )
              staging.clear()
            }
          }
        }
      }
    }
  } finally {
    lib.destroyContext(context)
  }
})

test("dimension records canonicalize ignored edges before packing byte selectors", () => {
  const { context, node } = setup()
  try {
    const staging = new SceneStaging()
    // Checked Yoga ignores the edge selector for dimensions, including large u32 values.
    staging.stageStyle(context, node, 2, 0, 0xffffffff, 1, 7, 0)
    lib.sceneFlush(context, staging)
    assert.deepEqual(lib.sceneGetStyle(context, node, 2, 0, 0), { unit: 1, value: 7 })
  } finally {
    lib.destroyContext(context)
  }
})

test("flush refuses to run inside a Yoga callback", () => {
  const { context, node } = setup()
  try {
    const staging = new SceneStaging()
    staging.stageStyle(context, node, 4, 0, 0, 1, 6, 0)
    lib.getYogaHost().invokeCallback(() => {
      assert.throws(() => lib.sceneFlush(context, staging), /Cannot mutate Yoga during a callback/)
    })
    lib.getYogaHost().throwCallbackError()
    assert.ok(staging.pending)
    lib.sceneFlush(context, staging)
    assert.equal(lib.sceneGetStyle(context, node, 4, 0, 0).value, 6)
  } finally {
    lib.destroyContext(context)
  }
})

test("staged paint coalescing validates full handle identity on every write", () => {
  const { context, node } = setup()
  const other = setup()
  try {
    for (const initial of ["background", "paint"] as const) {
      const staging = new SceneStaging()
      if (initial === "background") staging.stageBackground(context, node, RGBA.fromInts(1, 0, 0))
      else staging.stagePaint(context, node, paint())
      for (const invalid of [
        other.node,
        { ...node, contextId: node.contextId + 1n },
        { ...node, contextId: node.contextId + 0x100000000n },
        { ...node, generation: node.generation + 1 },
      ]) {
        assert.throws(() => staging.stageBackground(context, invalid, RGBA.fromInts(2, 0, 0)), NativeError)
        assert.throws(() => staging.stagePaint(context, invalid, paint()), NativeError)
      }
      assert.throws(() => staging.stageBackground(context, { ...node, slot: -1 }, RGBA.fromInts(3, 0, 0)), RangeError)
      lib.sceneFlush(context, staging)
    }
  } finally {
    lib.destroyContext(other.context)
    lib.destroyContext(context)
  }
})
