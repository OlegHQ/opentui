# Xi startup branch

Based on upstream `v0.5.11` (`6b9863ea7c5fae22bfebb23c242ddcc4c2b0aa0e`).
The Xi editor pins this repository as a submodule and consumes the generated
Bun dependency patch at `patches/opentui-core-0.5.11.patch`.

The native symbol table has 423 functions. Binding all of them during module
evaluation cost approximately 90 ms on the measured Linux arm64/Bun 1.3.13 host.
`platform/lazy-library.ts` binds only used functions, then replaces each property
with the direct backend function. All handles and callbacks retain explicit
cleanup. Definitions, argument conversion and native binaries are unchanged.

Bun's embedded executable paths load independent native images on repeated
`dlopen`. Unix executables therefore materialize one private process-lifetime
library file before binding, removed on orderly exit. Windows embedded DLLs and
explicit unmaterialized virtual-path overrides retain one eager load. Installed
packages use deferred bindings on both Bun and Node.

To regenerate from the pristine published npm package:

```sh
bun scripts/xi-startup-patch.ts /path/to/pristine/opentui-core-package
bun scripts/xi-startup-patch.ts /path/to/pristine/opentui-core-package --check
```

Use Bun 1.3.13 for byte-identical patch generation. Source maps for the existing
bundle retain their original mappings; appended helper code has no source map.
The patch includes both runtime chunks and retains the upstream native ABI.

The `@opentui/core/renderer` entry exposes renderer primitives without loading
the all-widgets root entry. `src/renderer-entry.ts` owns its public surface.
The patch generator resolves its runtime exports to the published shared chunks
and emits declarations from the re-export-only source. It fails if an export
cannot share its original implementation. The regular Bun/Node library build
also emits the entry. Neither path duplicates renderer classes or native state;
renderer-internal shared dependencies remain on the startup graph.

The narrowed entry passes shared-export identity checks in both packed Bun and
Node distribution tests. Xi checks mixed full/narrow/testing imports with an
actual render and disposal, and source/ESM-bytecode first-input Unicode bursts.

Validation performed on Linux arm64:

- Focused lazy-library ownership/error tests and compiled native-state/cleanup
  regression pass; TypeScript, formatting and lint pass.
- Full Bun suite: 5,678 pass, 24 skip, 13 fail. Twelve Kitty file-transport tests
  and the source-tree Node asset manifest test fail identically on unchanged
  upstream 0.5.11 in this environment.
- Node 26.4.0 suite: 4,929 pass, 8 skip, 12 fail, including the new portable
  tests. The twelve failures are the same Kitty transport fixtures.
- Packed distribution smoke tests pass using unchanged published native assets
  (`bun run build:lib`, then `bun run test:dist -- --skip-build`). A native rebuild
  was not performed; the environment has no Zig compiler.
- Xi's static checks, UI fixtures, 24 production interaction fixtures and
  compiled distribution smoke tests pass with the generated patch installed.

Remaining release work includes physical display latency, the complete loaded
input matrix, non-Linux platforms and upstream failure remediation. Deferred
functions still pay their binding cost on first use; measured startup and first
input evidence belongs to Xi's `docs/evidence/T122.md`, not a universal timing
claim. SIGKILL cannot run extracted-file cleanup.

## Avoid unused initialization (Xi T141)

Runtime conditions select Bun's native width/ANSI helpers without evaluating the
Node fallback packages. Node keeps the original string-width/strip-ansi behavior.
The timing widget constructs its grapheme segmenter only when truncating text.
On Bun, Markdown loads its lexer synchronously on first use instead of during an
unrelated widget import. Node retains the static lexer import. This postpones
optional Markdown work; it does not make the first Markdown render free.

The generated patch wraps the published, already-bundled Markdown lexer in a
cached initializer. It must remain self-contained: bare `require` in the published
`// @bun` bundle is unavailable, while aliasing `import.meta.require` can hide a
dependency from executable bundling. Xi's compiled initial/incremental Markdown
smoke checks this consumer path separately from the source tests.

When validating a changed patch with Bun 1.3.13, use a fresh temporary
`BUN_INSTALL_CACHE_DIR` with `bun install --force`. This session observed stale
patched JS even after an ordinary forced reinstall. Verify installed JS hashes
and retain them in benchmark manifests; a changed patch file alone is insufficient.

Current measurements and limitations belong to Xi's `docs/evidence/T141.md`.
Native binding batching was tried and discarded because paired measurements did
not establish a gain. The native library and input/frame scheduling are unchanged.

T141 validation: 224 focused Markdown/runtime/import checks and four timing-widget
checks pass, as do typecheck, library build, packed Bun/Node tests, formatting and
lint. Full Bun: 5,686 pass / 24 skip / 12 known Kitty failures; Node: 4,935 pass /
8 skip / the same 12 failures. These failures still block a complete suite pass.
