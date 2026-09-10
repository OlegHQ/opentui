import { spyOn, test } from "bun:test"
import assert from "node:assert/strict"
import { RGBA } from "../lib/RGBA.js"
import { withBufferAccess } from "../lib/buffer-access.js"
import { NativeStatus, resolveRenderLib, type NativeBufferDraw, type NativeDrawingTarget } from "../zig.js"

const lib = resolveRenderLib()
const red = RGBA.fromInts(255, 0, 0)
const blue = RGBA.fromInts(0, 0, 255)

test("drawing transport clears optional values between operations", () => {
  const context = lib.createContext({ objectCapacity: 8, renderCellsMax: 16 })
  const session = lib.createSession(context, { chunkSize: 1024, spanCapacity: 2, maxBytes: 2048n })
  lib.sessionAttachRenderer(context, session, { width: 4, height: 1, remote: true })
  lib.sceneCreateNode(context, session, "root", 1)
  const source = lib.createContextBuffer(context, { width: 4, height: 1 })
  const draw = spyOn((lib as any).opentui.symbols, "ot_buffer_draw")
  try {
    const frame = lib.sceneFrameStep(context, session, null, {
      background: red,
      useMouse: true,
      excludedHitNum: 0,
      maxLayoutRounds: 8,
      maxHostRequests: 64,
    })
    lib.contextDrawBuffer(
      { context, target: session, frame },
      {
        operation: "compose",
        source,
        sourceWidth: 1,
        sourceHeight: 1,
      },
    )
    lib.contextDrawBuffer(
      { context, target: session, frame },
      {
        operation: "text",
        text: "test",
        foreground: blue,
      },
    )
    const lease = lib.sceneFrameAcquireBufferLease(context, session, frame, "next")
    try {
      const bytes = new Uint8Array(4)
      assert.equal(lib.contextBufferLeaseWriteResolvedChars(context, lease.handle, bytes, false), 4)
      assert.equal(Buffer.from(bytes).toString(), "test")
    } finally {
      lib.contextReleaseBufferLease(context, lease.handle)
    }
    lib.sceneFrameCancel(context, session, frame.frameId)
    assert.throws(() => lib.contextDrawBuffer({ context, target: session, frame }, { operation: "clear" }), {
      status: NativeStatus.StaleFrame,
    })
    const reads: string[] = []
    const fill = {
      operation: "fill" as const,
      width: 4,
      height: 1,
      background: blue,
      get text() {
        reads.push("text")
        return ""
      },
      get bottomTitle() {
        reads.push("bottom")
        return ""
      },
    }
    lib.contextDrawBuffer({ context, target: source, frame: null }, fill)
    assert.deepEqual(reads, [])
    withBufferAccess(lib, context, lib.contextAcquireBufferLease(context, source), (cells) =>
      assert.deepEqual([...cells.bg.slice(0, 4)], [...blue.buffer]),
    )
    const invalid = RGBA.fromInts(1, 2, 3)
    invalid.buffer[2] = 256
    const calls = draw.mock.calls.length
    assert.throws(
      () =>
        lib.contextDrawBuffer(
          { context, target: source, frame: null },
          {
            operation: "text",
            text: "bad!",
            foreground: invalid,
          },
        ),
      /Invalid terminal color intent/,
    )
    assert.equal(draw.mock.calls.length, calls)
    lib.contextDrawBuffer({ context, target: source, frame: null }, { operation: "clear" })
    withBufferAccess(lib, context, lib.contextAcquireBufferLease(context, source), (cells) =>
      assert.deepEqual([...cells.bg], Array(16).fill(0)),
    )
  } finally {
    draw.mockRestore()
    lib.destroyContext(context)
  }
})

test.each(["handle", "options"] as const)("drawing transport isolates %s reentry", (phase) => {
  const context = lib.createContext({ objectCapacity: 4, renderCellsMax: 16 })
  const first = lib.createContextBuffer(context, { width: 4, height: 1 })
  const second = lib.createContextBuffer(context, { width: 4, height: 1 })
  const nested = () =>
    lib.contextDrawBuffer(
      { context, target: second, frame: null },
      {
        operation: "text",
        text: "peer",
        foreground: blue,
      },
    )
  try {
    lib.contextDrawBuffer(
      {
        context,
        frame: null,
        target:
          phase === "handle"
            ? {
                ...first,
                get slot() {
                  nested()
                  return first.slot
                },
              }
            : first,
      },
      {
        operation: "text",
        text: "self",
        get foreground() {
          if (phase === "options") nested()
          return red
        },
      },
    )
    for (const [buffer, text, color] of [
      [first, "self", red],
      [second, "peer", blue],
    ] as const) {
      withBufferAccess(lib, context, lib.contextAcquireBufferLease(context, buffer), (cells) => {
        assert.equal(String.fromCodePoint(...cells.char), text)
        assert.deepEqual([...cells.fg.slice(0, 4)], [...color.buffer])
      })
    }
    const invalid: NativeBufferDraw = { operation: "fill", width: 4, height: 1, background: red, x: Infinity }
    assert.throws(() => lib.contextDrawBuffer({ context, target: first, frame: null }, invalid), RangeError)
    lib.contextDrawBuffer(
      { context, target: first, frame: null },
      { operation: "text", text: "next", foreground: blue },
    )
    withBufferAccess(lib, context, lib.contextAcquireBufferLease(context, first), (cells) =>
      assert.equal(String.fromCodePoint(...cells.char), "next"),
    )
  } finally {
    lib.destroyContext(context)
  }
})

test.each(["draw", "layout"] as const)("%s transport rejects an owner destroyed during encoding", (operation) => {
  const context = lib.createContext({ objectCapacity: 4, renderCellsMax: 16 })
  const session = lib.createSession(context, { chunkSize: 1024, spanCapacity: 2, maxBytes: 2048n })
  lib.sessionAttachRenderer(context, session, { width: 4, height: 1, remote: true })
  const node = lib.sceneCreateNode(context, session, "root", 1)
  const buffer = lib.createContextBuffer(context, { width: 4, height: 1 })
  const symbol = operation === "draw" ? "ot_buffer_draw" : "ot_scene_get_layout"
  const call = spyOn((lib as any).opentui.symbols, symbol)
  let destroyed = false
  const destroy = () => {
    lib.destroyContext(context)
    destroyed = true
  }
  try {
    assert.throws(
      () =>
        operation === "draw"
          ? lib.contextDrawBuffer(
              { context, target: buffer, frame: null },
              {
                operation: "text",
                get text() {
                  destroy()
                  return ""
                },
              },
            )
          : lib.sceneGetLayout(context, {
              ...node,
              get generation() {
                destroy()
                return node.generation
              },
            }),
      { status: NativeStatus.WrongContext },
    )
    assert.equal(call.mock.calls.length, 0)
  } finally {
    call.mockRestore()
    if (!destroyed) lib.destroyContext(context)
  }
})

test("drawing transport reads only operation fields and snapshots each getter once", () => {
  const context = lib.createContext({ objectCapacity: 4, renderCellsMax: 16 })
  const buffer = lib.createContextBuffer(context, { width: 4, height: 1 })
  const reads: string[] = []
  const options = new Proxy(
    { operation: "text", text: "test", foreground: red },
    {
      get(target, key) {
        assert.ok(["operation", "text", "foreground", "background", "x", "y", "attributes"].includes(String(key)))
        assert.ok(!reads.includes(String(key)), `Repeated getter: ${String(key)}`)
        reads.push(String(key))
        return Reflect.get(target, key)
      },
    },
  ) as NativeBufferDraw
  const call = spyOn((lib as any).opentui.symbols, "ot_buffer_draw")
  try {
    lib.contextDrawBuffer({ context, target: buffer, frame: null }, options)
    assert.equal(call.mock.calls.length, 1)
    assert.equal((call.mock.calls[0][3] as Uint32Array).byteLength, 44)
    withBufferAccess(lib, context, lib.contextAcquireBufferLease(context, buffer), (cells) => {
      assert.equal(String.fromCodePoint(...cells.char), "test")
      assert.deepEqual([...cells.fg.slice(0, 4)], [...red.buffer])
    })
  } finally {
    call.mockRestore()
    lib.destroyContext(context)
  }
})

test("focused draw records preserve owned-buffer and frame cell parity", () => {
  const context = lib.createContext({ objectCapacity: 8, renderCellsMax: 32 })
  const session = lib.createSession(context, { chunkSize: 1024, spanCapacity: 2, maxBytes: 2048n })
  const buffer = lib.createContextBuffer(context, { width: 8, height: 4 })
  const source = lib.createContextBuffer(context, { width: 2, height: 1 })
  const black = RGBA.fromInts(0, 0, 0)
  try {
    lib.sessionAttachRenderer(context, session, { width: 8, height: 4, remote: true })
    lib.sceneCreateNode(context, session, "root", 1)
    lib.contextDrawBuffer({ context, target: source, frame: null }, { operation: "text", text: "xy", foreground: red })
    const frame = lib.sceneFrameStep(context, session, null, {
      background: black,
      useMouse: false,
      excludedHitNum: 0,
      maxLayoutRounds: 8,
      maxHostRequests: 64,
    })
    const operations: NativeBufferDraw[] = [
      { operation: "clear", background: black },
      {
        operation: "box",
        width: 8,
        height: 4,
        packedOptions: 31,
        foreground: red,
        background: black,
        titleColor: blue,
        borderChars: new Uint32Array(11).fill(35),
        text: "T",
        bottomTitle: "B",
      },
      { operation: "fill", x: 1, y: 1, width: 6, height: 2, background: blue },
      { operation: "text", x: 1, y: 1, text: "ABCD", foreground: red, attributes: 1 },
      { operation: "cell", x: 1, y: 2, char: 67, foreground: blue, background: red, attributes: 2 },
      { operation: "cellBlend", x: 2, y: 2, char: 76, foreground: blue, background: red, attributes: 4 },
      { operation: "char", x: 3, y: 2, char: 82, foreground: blue, background: red, attributes: 8 },
      { operation: "compose", source, x: 5, y: 1, sourceX: 1 },
      { operation: "compose", source, x: 4, y: 1, sourceWidth: 0 },
      { operation: "compose", source, x: 4, y: 1, sourceHeight: 0 },
    ]
    const draw = spyOn((lib as any).opentui.symbols, "ot_buffer_draw")
    try {
      const owned = { context, target: buffer, frame: null }
      lib.contextDrawBuffer(owned, { operation: "respectAlpha", enabled: true })
      lib.contextDrawBuffer(owned, { operation: "respectAlpha", enabled: false })
      const snapshots = []
      for (const target of [owned, { context, target: session, frame }]) {
        for (const operation of operations) lib.contextDrawBuffer(target, operation)
        const lease =
          target.frame === null
            ? lib.contextAcquireBufferLease(context, buffer)
            : lib.sceneFrameAcquireBufferLease(context, session, frame, "next")
        snapshots.push(
          withBufferAccess(lib, context, lease, ({ char, fg, bg, attributes }) => ({
            char: char.slice(),
            fg: fg.slice(),
            bg: bg.slice(),
            attributes: attributes.slice(),
          })),
        )
      }
      assert.deepEqual(snapshots[1], snapshots[0])
      const { char, fg, bg, attributes } = snapshots[0]
      assert.equal(String.fromCodePoint(...char.slice(9, 14)), "ABCDy")
      assert.equal(String.fromCodePoint(...char.slice(17, 20)), "CLR")
      assert.ok(char.slice(0, 8).includes(84))
      assert.ok(char.slice(24).includes(66))
      assert.deepEqual([...fg.slice(36, 40)], [...red.buffer])
      assert.deepEqual([...bg.slice(36, 40)], [...blue.buffer])
      assert.deepEqual([...attributes.slice(17, 20)], [2, 4, 8])
      assert.deepEqual(
        draw.mock.calls.map((call) => (call[3] as Uint32Array).byteLength),
        [20, 20, ...[24, 104, 40, 44, 48, 48, 48, 40, 40, 40], ...[24, 104, 40, 44, 48, 48, 48, 40, 40, 40]],
      )
      assert.throws(
        () => lib.contextDrawBuffer({ context, target: session, frame }, { operation: "respectAlpha", enabled: true }),
        {
          status: NativeStatus.InvalidArgument,
        },
      )
    } finally {
      draw.mockRestore()
    }
  } finally {
    lib.destroyContext(context)
  }
})

test("drawing targets check identity and frame authority even for empty bulk operations", () => {
  const context = lib.createContext({ objectCapacity: 8, renderCellsMax: 8 })
  const foreign = lib.createContext({ objectCapacity: 2, renderCellsMax: 8 })
  const buffer = lib.createContextBuffer(context, { width: 2, height: 1 })
  const session = lib.createSession(context, { chunkSize: 1024, spanCapacity: 2, maxBytes: 2048n })
  const peer = lib.createSession(context, { chunkSize: 1024, spanCapacity: 2, maxBytes: 2048n })
  const draw: ((target: NativeDrawingTarget) => unknown)[] = [
    (target) => lib.contextDrawBuffer(target, { operation: "text", text: "" }),
    (target) => lib.contextBufferStack(target, { operation: "getOpacity" }),
    (target) => lib.contextDrawGrayscaleBuffer(target, new Float32Array(), 0, 0, 0, 0, null, null, false),
    (target) => lib.contextColorMatrixBuffer(target, new Float32Array(16), null, 0, 3),
  ]
  try {
    for (const [id, target] of [session, peer].entries()) {
      lib.sessionAttachRenderer(context, target, { width: 2, height: 1, remote: true })
      lib.sceneCreateNode(context, target, "root", id + 1)
    }
    const frame = lib.sceneFrameStep(context, session, null, {
      background: red,
      useMouse: false,
      excludedHitNum: 0,
      maxLayoutRounds: 8,
      maxHostRequests: 64,
    })
    for (const operation of draw) {
      operation({ context, target: buffer, frame: null })
      operation({ context, target: session, frame })
      assert.throws(() => operation({ context: foreign, target: buffer, frame: null }), {
        status: NativeStatus.WrongContext,
      })
      assert.throws(() => operation({ context, target: peer, frame }), { status: NativeStatus.WrongSession })
      for (const invalid of [
        { context, target: session, frame: null },
        { context, target: buffer, frame },
      ]) {
        assert.throws(() => operation(invalid as never), { status: NativeStatus.WrongKind })
      }
    }
    const lease = lib.sceneFrameAcquireBufferLease(context, session, frame, "next")
    try {
      lib.sceneFrameCancel(context, session, frame.frameId)
      for (const operation of draw) {
        assert.throws(() => operation({ context, target: session, frame }), { status: NativeStatus.StaleFrame })
      }
      assert.throws(() => lib.contextValidateBufferLease(context, lease.handle), { status: NativeStatus.StaleLease })
    } finally {
      lib.contextReleaseBufferLease(context, lease.handle)
    }
  } finally {
    lib.destroyContext(context)
    lib.destroyContext(foreign)
  }
})
