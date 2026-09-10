import { expect, spyOn, test } from "bun:test"
import { NativeImage, NativeImagePool, imageInfo } from "../image.js"
import { OptimizedBuffer, ResourceContext } from "../buffer.js"
import { NativeError, NativeStatus, resolveRenderLib } from "../zig.js"

test.each([
  ["RGBA", () => NativeImage.fromRgba(Uint8Array.of(1, 2, 3, 255), 1, 1)],
  ["pixels", () => NativeImage.fromPixels(Uint8Array.of(1, 2, 3, 255), 1, 1)],
  ["decode", () => NativeImage.decode(Uint8Array.of(1))],
  ["inspect", () => imageInfo(Uint8Array.of(1))],
] as const)("image %s rejects Yoga callbacks before allocating an automatic Context", (_, create) => {
  const lib = resolveRenderLib()
  const allocate = spyOn(lib, "createContext")
  try {
    lib.getYogaHost().invokeCallback(() => {
      expect(create).toThrow("Cannot mutate Yoga during a callback")
    })
    lib.getYogaHost().throwCallbackError()
    expect(allocate.mock.calls).toHaveLength(0)
  } finally {
    allocate.mockRestore()
    const retry = NativeImage.fromRgba(Uint8Array.of(1, 2, 3, 255), 1, 1)
    retry.dispose()
  }
})

test("checked image creation shares a Context and retains scene-independent pixels", () => {
  const owner = new ResourceContext({ objectCapacity: 8, renderCellsMax: 1 })
  const image = NativeImage.fromPixels(Uint8Array.of(3, 2, 1, 255), 1, 1, { owner, format: "bgra8" })
  const buffer = OptimizedBuffer.create(1, 1, "unicode", { owner })
  try {
    expect(image.ptr.context).toBe(owner.context)
    expect(buffer.drawImage(image, 0, 0, 1, 1)).toBe(true)
    expect(() => image.takeRaw()).toThrow("retain")
    image.dispose()
    expect(buffer.getRealCharBytes(false).length).toBeGreaterThan(0)
  } finally {
    image.dispose()
    buffer.destroy()
    owner.destroy()
  }
})

test("checked raw transfer blocks Context teardown until release", () => {
  const owner = new ResourceContext({ objectCapacity: 4, renderCellsMax: 1 })
  const image = NativeImage.fromPixels(Uint8Array.of(1, 2, 3, 255), 1, 1, { owner })
  const raw = image.takeRaw()
  try {
    expect(() => owner.destroy()).toThrow(NativeError)
    raw.data[0] = 42
    expect(raw.data[0]).toBe(42)
    expect(() => image.raw()).toThrow("disposed")
  } finally {
    raw.dispose()
    raw.dispose()
    owner.destroy()
  }
})

test("image wrappers reject access after explicit Context teardown and dispose cleanly", () => {
  const owner = new ResourceContext({ objectCapacity: 2, renderCellsMax: 1 })
  const image = NativeImage.fromPixels(Uint8Array.of(1, 2, 3, 255), 1, 1, { owner })
  owner.destroy()
  expect(() => image.raw()).toThrow("destroyed")
  image.dispose()
  image.dispose()
})

test.each([false, true])(
  "failed image wrapper publication releases native storage (explicit owner: %s)",
  (explicit) => {
    const owner = explicit ? new ResourceContext({ objectCapacity: 1, renderCellsMax: 1 }) : undefined
    const lib = resolveRenderLib()
    const getInfo = lib.imageGetInfo
    const failure = new Error("metadata publication failed")
    let handle: Parameters<typeof getInfo>[0] | undefined
    lib.imageGetInfo = (candidate) => {
      handle = candidate
      throw failure
    }
    try {
      expect(() => NativeImage.fromPixels(Uint8Array.of(1, 2, 3, 255), 1, 1, { owner })).toThrow(failure)
    } finally {
      lib.imageGetInfo = getInfo
    }
    try {
      if (owner) {
        expect(lib.imageGetInfo(handle!).status).toBe(1)
        const retry = NativeImage.fromPixels(Uint8Array.of(1, 2, 3, 255), 1, 1, { owner })
        retry.dispose()
      } else {
        expect(() => lib.imageGetInfo(handle!)).toThrow(NativeError)
      }
    } finally {
      owner?.destroy()
    }
  },
)

test("automatic Context remains alive during reentrant image publication", () => {
  const lib = resolveRenderLib()
  const getInfo = lib.imageGetInfo
  lib.imageGetInfo = (handle) => {
    lib.imageGetInfo = getInfo
    const nested = NativeImage.fromRgba(Uint8Array.of(4, 5, 6, 255), 1, 1)
    nested.dispose()
    return getInfo.call(lib, handle)
  }
  let image: NativeImage | undefined
  try {
    image = NativeImage.fromRgba(Uint8Array.of(1, 2, 3, 255), 1, 1)
    expect(image.raw().data).toEqual(Uint8Array.of(1, 2, 3, 255))
  } finally {
    lib.imageGetInfo = getInfo
    image?.dispose()
  }
})

test("Context capacity failures preserve image owners and pooled publications", () => {
  const owner = new ResourceContext({ objectCapacity: 1, renderCellsMax: 1 })
  const pool = new NativeImagePool({ width: 1, height: 1, capacity: 1, owner })
  try {
    expect(() => pool.publishRgba(Uint8Array.of(1, 2, 3, 255))).toThrow(NativeError)
  } finally {
    pool.dispose()
    owner.destroy()
  }
})

test("same-Context pool publications stay immutable while buffers retain them", () => {
  const owner = new ResourceContext({ objectCapacity: 8, renderCellsMax: 1 })
  const pool = new NativeImagePool({ width: 1, height: 1, capacity: 1, owner })
  const buffer = OptimizedBuffer.create(1, 1, "unicode", { owner })
  const pixels = Uint8Array.of(1, 2, 3, 255)
  const image = pool.publishRgba(pixels)!
  try {
    buffer.drawImage(image, 0, 0, 1, 1)
    image.dispose()
    pixels[0] = 42
    expect(pool.publishRgba(pixels)).toBeNull()
    buffer.clear()
    const next = pool.publishRgba(pixels)!
    try {
      expect(next.raw().data).toEqual(pixels)
    } finally {
      next.dispose()
    }
  } finally {
    image.dispose()
    buffer.destroy()
    pool.dispose()
    owner.destroy()
  }
})

test("automatic image Context follows retained handles and exported raw storage", () => {
  const image = NativeImage.fromRgba(Uint8Array.of(1, 2, 3, 255), 1, 1)
  const handle = image.ptr
  const retained = image.retain()
  image.dispose()
  const raw = retained.takeRaw()
  expect(raw.data).toEqual(Uint8Array.of(1, 2, 3, 255))
  raw.dispose()
  try {
    resolveRenderLib().imageGetInfo(handle)
    throw new Error("Context remained live")
  } catch (error) {
    expect(error).toBeInstanceOf(NativeError)
    expect((error as NativeError).status).toBe(NativeStatus.WrongContext)
  }
})
