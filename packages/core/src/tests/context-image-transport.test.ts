import { test } from "bun:test"
import assert from "node:assert/strict"
import { RGBA } from "../lib/RGBA.js"
import { NativeStatus, resolveRenderLib, type ImageHandle, type NativeContextHandle } from "../zig.js"

const lib = resolveRenderLib()
const options = { objectCapacity: 16, renderCellsMax: 128 }

const imageSpans: Array<[string, (context: NativeContextHandle, image: ImageHandle, bytes: Uint8Array) => unknown]> = [
  ["ot_image_inspect", (context, _, bytes) => lib.imageInfo(context, bytes)],
  ["ot_image_decode", (context, _, bytes) => lib.imageDecode(context, bytes)],
  ["ot_image_create_pixels", (context, _, bytes) => lib.imageCreateFromPixels(context, bytes, 1, 1, 4, 0, 0)],
  ["ot_image_update_pixels", (_, image, bytes) => lib.imageUpdatePixels(image, bytes, 4, 0, 0)],
  ["ot_image_copy_pixels", (_, image, bytes) => lib.imageCopyPixels(image, bytes, 4, false)],
  ["ot_image_copy_png", (_, image, bytes) => lib.imageCopyPng(image, bytes)],
  ["ot_image_extend", (_, image, bytes) => lib.imageExtend(image, 0, 0, 0, 0, bytes)],
]

test.each(imageSpans)("%s evaluates byte length before resolving its Context", (symbol, operation) => {
  const context = lib.createContext(options)
  const image = lib.imageCreateFromRgba(context, Uint8Array.of(1, 2, 3, 255), 1, 1, 4).handle!
  const symbols = Reflect.get(lib, "opentui").symbols
  const original = symbols[symbol]
  let calls = 0
  let destroyed = false
  symbols[symbol] = () => {
    calls++
    return NativeStatus.InvalidArgument
  }
  const bytes = new Uint8Array(4)
  Object.defineProperty(bytes, "byteLength", {
    get() {
      lib.destroyContext(context)
      destroyed = true
      return 4
    },
  })
  try {
    assert.throws(() => operation(context, image, bytes), { status: NativeStatus.WrongContext })
    assert.equal(calls, 0)
  } finally {
    symbols[symbol] = original
    if (!destroyed) lib.destroyContext(context)
  }
})

test.each(imageSpans)("%s uses intrinsic shared-view storage before native access", (symbol, operation) => {
  const context = lib.createContext(options)
  const image = lib.imageCreateFromRgba(context, Uint8Array.of(1, 2, 3, 255), 1, 1, 4).handle!
  const symbols = Reflect.get(lib, "opentui").symbols
  const original = symbols[symbol]
  const storage = new SharedArrayBuffer(6)
  const bytes = new Uint8Array(storage, 1, 4)
  Object.defineProperties(bytes, {
    buffer: {
      get: () => {
        throw new Error("caller buffer getter reached native access")
      },
    },
    byteOffset: {
      get: () => {
        throw new Error("caller offset getter reached native access")
      },
    },
  })
  let calls = 0
  symbols[symbol] = (...args: unknown[]) => {
    const input = args.find((value): value is Uint8Array => value instanceof Uint8Array)!
    assert.equal(input.buffer, storage)
    assert.equal(input.byteOffset, 1)
    assert.equal(input.byteLength, 4)
    calls++
    return NativeStatus.InvalidArgument
  }
  try {
    operation(context, image, bytes)
    assert.equal(calls, 1)
  } finally {
    symbols[symbol] = original
    lib.destroyContext(context)
  }
})

test.each([
  ["ot_image_resize", (image: ImageHandle, value: number) => lib.imageResize(image, value, 1, 0)],
  ["ot_image_composite", (image: ImageHandle, value: number) => lib.imageComposite(image, image, value, 0, 0, 255)],
  ["ot_image_composite", (image: ImageHandle, value: number) => lib.imageComposite(image, image, 0, 0, 0, value)],
] as const)("%s rejects coercible scalar inputs before native access", (symbol, operation) => {
  const context = lib.createContext(options)
  const image = lib.imageCreateFromRgba(context, Uint8Array.of(1, 2, 3, 255), 1, 1, 4).handle!
  const symbols = Reflect.get(lib, "opentui").symbols
  const original = symbols[symbol]
  let calls = 0
  symbols[symbol] = () => {
    calls++
    return NativeStatus.InvalidArgument
  }
  const value = {
    valueOf() {
      throw new Error("coercion reached native access")
    },
  } as unknown as number
  try {
    assert.throws(() => operation(image, value), RangeError)
    assert.equal(calls, 0)
  } finally {
    symbols[symbol] = original
    lib.destroyContext(context)
  }
})

test("image cloning snapshots its source Context before resolving the destination", () => {
  const context = lib.createContext(options)
  const other = lib.createContext(options)
  const image = lib.imageCreateFromRgba(context, Uint8Array.of(1, 2, 3, 255), 1, 1, 4).handle!
  const symbols = Reflect.get(lib, "opentui").symbols
  const original = symbols.ot_image_clone
  let calls = 0
  let reads = 0
  let destroyed = false
  symbols.ot_image_clone = () => {
    calls++
    return NativeStatus.InvalidArgument
  }
  const source = {
    ...image,
    get context() {
      reads++
      if (reads > 2) {
        lib.destroyContext(other)
        destroyed = true
      }
      return context
    },
  }
  try {
    try {
      const clone = lib.imageClone(source, other)
      assert.equal(clone.status, 7)
    } catch (error) {
      assert.equal(destroyed, true)
      assert.equal(Reflect.get(error as object, "status"), NativeStatus.WrongContext)
    }
    assert.equal(calls, destroyed ? 0 : 1)
  } finally {
    symbols.ot_image_clone = original
    if (!destroyed) lib.destroyContext(other)
    lib.destroyContext(context)
  }
})

test("Context image clone outlives its checked source and rejects stale handles", () => {
  const context = lib.createContext(options)
  const source = lib.imageCreateFromRgba(context, Uint8Array.of(255, 0, 0, 255), 1, 1, 4).handle!
  try {
    const image = lib.importContextImage(context, source)
    lib.imageDestroy(source)
    const target = lib.createContextBuffer(context, { width: 2, height: 1 })
    assert.equal(
      lib.contextDrawImage({ context, target, frame: null }, image, { width: 2, height: 1, protocol: "blocks" }),
      true,
    )
    assert.equal(lib.contextDrawImage({ context, target, frame: null }, image, { x: 2, width: 2, height: 1 }), false)
    lib.destroyContextImage(context, image)
    assert.throws(() => lib.contextDrawImage({ context, target, frame: null }, image, { width: 2, height: 1 }), {
      status: NativeStatus.StaleHandle,
    })
    assert.equal(lib.imageClone(source).status, 1)
  } finally {
    lib.destroyContext(context)
  }
})

test("Context image transport checks owners kinds optional backing storage and dimensions", () => {
  const context = lib.createContext(options)
  const other = lib.createContext(options)
  const source = lib.imageCreateFromRgba(other, Uint8Array.of(255, 0, 0, 255), 1, 1, 4).handle!
  try {
    const image = lib.importContextImage(context, source)
    const target = lib.createContextBuffer(context, { width: 2, height: 1 })
    const foreign = lib.createContextBuffer(other, { width: 2, height: 1 })
    const session = lib.createSession(context, { chunkSize: 64, spanCapacity: 16, maxBytes: 1024n })
    lib.sessionAttachRenderer(context, session, { width: 2, height: 1, remote: false, environment: {} })
    lib.sceneCreateNode(context, session, "root", 1)
    const node = lib.sceneCreateNode(context, session, "image", 2)
    lib.sceneSetImage(context, node, image, "cover", "blocks", target)
    lib.sessionSetImageResolution(context, session, 2, 1, 16, 16)
    lib.sessionSetImageResolution(context, session, 0, 0, 0, 0)
    assert.throws(() => lib.sessionSetImageResolution(context, session, 2, 0, 16, 16), {
      status: NativeStatus.InvalidArgument,
    })
    assert.throws(() => lib.sceneSetImage(context, node, image, "fit", "auto", foreign), {
      status: NativeStatus.WrongContext,
    })
    // @ts-expect-error The checked API also rejects an image used as buffer storage at runtime.
    assert.throws(() => lib.sceneSetImage(context, node, image, "fit", "auto", image), {
      status: NativeStatus.WrongKind,
    })
    assert.throws(() => lib.destroyContextImage(context, target as never), { status: NativeStatus.WrongKind })
    assert.throws(() => lib.destroyContextImage(other, image), { status: NativeStatus.WrongContext })
    assert.throws(
      () => lib.contextDrawImage({ context, target, frame: null }, target as never, { width: 2, height: 1 }),
      {
        status: NativeStatus.WrongKind,
      },
    )
    assert.throws(
      () => lib.contextDrawImage({ context: other, target: foreign, frame: null }, image, { width: 2, height: 1 }),
      {
        status: NativeStatus.WrongContext,
      },
    )
    for (const width of [-1, 0.5, Number.NaN, 0x1_0000_0000]) {
      assert.throws(
        () => lib.contextDrawImage({ context, target, frame: null }, image, { width, height: 1 }),
        RangeError,
      )
    }
    assert.throws(
      () => lib.contextDrawImage({ context, target, frame: null }, image, { width: 2, height: 1, x: 0x80000000 }),
      RangeError,
    )
    assert.throws(
      () =>
        lib.contextDrawImage({ context, target, frame: null }, image, {
          width: 2,
          height: 1,
          protocol: "constructor" as never,
        }),
      TypeError,
    )
    assert.throws(() => lib.sceneSetImage(context, node, image, "bad" as never, "auto", null), TypeError)
    const draw = { width: 2, height: 1, protocol: "blocks" as const }
    assert.throws(() => lib.contextDrawImage({ context, target: session, frame: null } as never, image, draw), {
      status: NativeStatus.WrongKind,
    })
    const frame = lib.sceneFrameStep(context, session, null, {
      background: RGBA.fromInts(0, 0, 0),
      useMouse: false,
      excludedHitNum: 0,
      maxLayoutRounds: 8,
      maxHostRequests: 64,
    })
    assert.equal(lib.contextDrawImage({ context, target: session, frame }, image, draw), true)
    assert.throws(
      () =>
        lib.contextDrawImage(
          { context, target: session, frame: { ...frame, frameId: frame.frameId + 1n } },
          image,
          draw,
        ),
      {
        status: NativeStatus.StaleFrame,
      },
    )
    lib.sceneFrameCancel(context, session, frame.frameId)
    assert.throws(() => lib.contextDrawImage({ context, target: session, frame }, image, draw), {
      status: NativeStatus.StaleFrame,
    })
    lib.destroyContextImage(context, image)
    lib.sceneSetImage(context, node, null, "fill", "auto", null)
    lib.sceneDestroyNode(context, node)
    assert.throws(() => lib.sceneSetImage(context, node, null, "fit", "auto", null), {
      status: NativeStatus.StaleHandle,
    })
  } finally {
    lib.imageDestroy(source)
    lib.destroyContext(context)
    lib.destroyContext(other)
  }
})

test("Context image transport resolves native ownership after draw option getters", () => {
  const context = lib.createContext(options)
  const source = lib.imageCreateFromRgba(context, Uint8Array.of(255, 0, 0, 255), 1, 1, 4).handle!
  let destroyed = false
  try {
    const image = lib.importContextImage(context, source)
    const target = lib.createContextBuffer(context, { width: 2, height: 1 })
    let reads = 0
    assert.equal(
      lib.contextDrawImage({ context, target, frame: null }, image, {
        width: 2,
        height: 1,
        get sourceWidth() {
          reads++
          assert.equal(
            lib.contextDrawImage({ context, target, frame: null }, image, { width: 2, height: 1, x: 2 }),
            false,
          )
          return 1
        },
      }),
      true,
    )
    assert.equal(reads, 1)
    assert.throws(
      () =>
        lib.contextDrawImage({ context, target, frame: null }, image, {
          get width() {
            lib.destroyContext(context)
            destroyed = true
            return 2
          },
          height: 1,
        }),
      { status: NativeStatus.WrongContext },
    )
  } finally {
    if (!destroyed) lib.destroyContext(context)
  }
})
