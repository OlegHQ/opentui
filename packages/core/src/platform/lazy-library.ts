import { dlopen, type FFIFunction, type Library } from "./ffi.js"

/**
 * Open the library immediately, but compile each remaining FFI trampoline only
 * when its symbol is used. A resolved property holds the backend function itself:
 * ordinary rendering has neither a Proxy trap nor a forwarding call.
 *
 * The first binding anchors library/callback lifetime. Each additional binding
 * owns a dlopen reference, released before that anchor and its callbacks. Native
 * symbol lookup errors for deferred functions are reported on first access.
 */
export function dlopenLazy<Fns extends Record<string, FFIFunction>>(
  path: string | URL,
  definitions: Fns,
  load: typeof dlopen = dlopen,
): Library<Fns> {
  // Unmaterialized Bun executable paths must keep one native image. This also
  // preserves explicit virtual-path overrides and Windows (loaded DLLs cannot
  // be unlinked there). The normal Unix compiled path is materialized first.
  if (String(path).includes("$bunfs") || /^B:[\\/]~BUN/i.test(String(path))) return load(path, definitions)
  const entries = Object.entries(definitions)
  const first = entries[0]
  if (!first) return load(path, definitions)
  const anchor = load(path, { [first[0]]: first[1] })
  const libraries = [anchor]
  const symbols = Object.create(null) as Library<Fns>["symbols"]
  let closed = false

  for (const [name, definition] of entries) {
    if (name === first[0]) {
      Object.defineProperty(symbols, name, {
        value: anchor.symbols[name],
        enumerable: true,
        writable: true,
        configurable: true,
      })
      continue
    }
    Object.defineProperty(symbols, name, {
      enumerable: true,
      configurable: true,
      get() {
        if (closed) throw new Error("Cannot resolve a symbol after library has closed")
        const library = load(path, { [name]: definition })
        libraries.push(library)
        const symbol = library.symbols[name]
        Object.defineProperty(symbols, name, { value: symbol, enumerable: true, configurable: true, writable: true })
        return symbol
      },
      set(value) {
        Object.defineProperty(symbols, name, { value, enumerable: true, configurable: true, writable: true })
      },
    })
  }

  return {
    symbols,
    createCallback(callback, definition) {
      if (closed) throw new Error("Cannot create a callback after library has closed")
      return anchor.createCallback(callback, definition)
    },
    close() {
      if (closed) return
      closed = true
      const failures: unknown[] = []
      for (let index = libraries.length - 1; index >= 0; index--) {
        try {
          libraries[index]!.close()
        } catch (error) {
          failures.push(error)
        }
      }
      libraries.length = 0
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, "Failed to close native bindings")
    },
  }
}
