import { expect, test } from "bun:test"
import { dlopen, type FFIFunction, type Library, type Pointer } from "./ffi.js"
import { dlopenLazy } from "./lazy-library.js"

function fixture(failClose = false) {
  const opened: string[] = []
  const closed: string[] = []
  const callbacks: string[] = []
  const functions = { first: (n: number) => n + 1, optional: (n: number) => n * 2 }
  const load: typeof dlopen = <Fns extends Record<string, FFIFunction>>(_path: string | URL, definitions: Fns) => {
    const name = Object.keys(definitions)[0]!
    if (!(name in functions)) throw new Error(`missing symbol: ${name}`)
    opened.push(name)
    return {
      symbols: Object.fromEntries(
        Object.keys(definitions).map((key) => [key, functions[key as keyof typeof functions]]),
      ),
      createCallback() {
        callbacks.push(name)
        return { ptr: 1 as Pointer, threadsafe: false, close() {} }
      },
      close() {
        closed.push(name)
        if (failClose && name === "optional") throw new Error("close failed")
      },
    } as unknown as Library<Fns>
  }
  return { opened, closed, callbacks, functions, load }
}

test("unused bindings are deferred, enumeration is inert, and resolved calls are direct and stable", () => {
  const f = fixture()
  const library = dlopenLazy("mock", { first: {}, optional: {} }, f.load)
  expect(f.opened).toEqual(["first"])
  expect(Object.keys(library.symbols)).toEqual(["first", "optional"])
  expect(f.opened).toEqual(["first"])
  expect(library.symbols.first(4)).toBe(5)
  expect(library.symbols.optional(4)).toBe(8)
  expect(library.symbols.optional).toBe(f.functions.optional)
  expect(Object.getOwnPropertyDescriptor(library.symbols, "optional")?.get).toBeUndefined()
  const replacement = () => 9
  library.symbols.optional = replacement
  expect(library.symbols.optional()).toBe(9)
  expect(f.opened).toEqual(["first", "optional"])
  library.createCallback(() => {}, {})
  expect(f.callbacks).toEqual(["first"])
  library.close()
  library.close()
  expect(f.closed).toEqual(["optional", "first"])
  expect(() => library.createCallback(() => {}, {})).toThrow("closed")
})

test("close does not load untouched bindings, and access after close cannot reopen native state", () => {
  const f = fixture()
  const library = dlopenLazy("mock", { first: {}, optional: {} }, f.load)
  library.close()
  expect(f.opened).toEqual(["first"])
  expect(f.closed).toEqual(["first"])
  expect(() => library.symbols.optional).toThrow("closed")
  expect(f.opened).toEqual(["first"])
})

test("a missing deferred symbol reports the backend error and leaves existing bindings usable", () => {
  const f = fixture()
  const library = dlopenLazy("mock", { first: {}, missing: {} }, f.load)
  expect(() => library.symbols.missing).toThrow("missing symbol: missing")
  expect(library.symbols.first(2)).toBe(3)
  library.close()
  expect(f.closed).toEqual(["first"])
})

test("every opened handle is closed even if one close fails", () => {
  const f = fixture(true)
  const library = dlopenLazy("mock", { first: {}, optional: {} }, f.load)
  library.symbols.optional(2)
  expect(() => library.close()).toThrow("close failed")
  expect(f.closed).toEqual(["optional", "first"])
  library.close()
  expect(f.closed).toEqual(["optional", "first"])
})

test("explicit embedded paths use one library image for all symbols", () => {
  for (const path of ["/$bunfs/root/libopentui.so", "B:\\~BUN\\root\\opentui.dll"]) {
    const f = fixture()
    const library = dlopenLazy(path, { first: {}, optional: {} }, f.load)
    expect(library.symbols.first(3)).toBe(4)
    expect(library.symbols.optional(3)).toBe(6)
    expect(f.opened).toEqual(["first"])
    library.close()
    expect(f.closed).toEqual(["first"])
  }
})
