# Native API

OpenTUI uses Context-owned scenes and Sessions for production rendering, including
text, editors, custom paint hooks, images, detached surfaces, and split output.
Standalone resources use the same checked ownership model without a terminal.

The [ownership and observation contract](docs/api-contract.md) describes resource
bindings, mutation visibility, text copy units, and scoped framebuffer access.

See [Host I/O and time](docs/host-io-time.md) for terminal delivery, Context file
operations, Session deadlines, and native diagnostic clock samples.

## API surfaces

- [`src/opentui.zig`](src/opentui.zig) exports the checked `Context` API and explicit
  raw Zig primitives, including `CliRenderer`, `NativeRenderable`, `OptimizedBuffer`,
  text buffers, and pools. Raw primitives remain a separate capability: callers
  manage their lifetimes and do not acquire Context guards merely by importing them.
- [`include/opentui.h`](include/opentui.h) defines the checked `ot_*` C ABI for
  Contexts, Sessions, scenes, drawing, text, editors, styles, leases, and diagnostics.
  It remains version 1 and experimental as an ABI, not an unused rendering backend.
- [`../core/src/zig.ts`](../core/src/zig.ts) supplies TypeScript wrappers over that
  checked ABI. Its checked signatures, callbacks, constants, and record layouts come
  from [`native-abi.generated.ts`](../core/src/native-abi.generated.ts).

## Paint, commit, and complete output

A retained scene produces one **painted draft**. `ot_scene_paint` returns its
`DONE` request for a hook-free scene. `ot_scene_frame_step_with_geometry` returns
the same kind of draft after you handle and acknowledge each issued host request.
Pass requests back unchanged. Geometry describes the node; it does not authorize
acknowledgement. `YIELD` grants neither drawing nor commit access.

After `DONE`, you can apply frame-qualified effects or capture the buffer. Release
all framebuffer leases, then call `ot_scene_frame_commit`. Cancel the draft with
`ot_scene_frame_cancel` if you abandon it. A new paint requires the preceding draft
to be consumed or cancelled and its presentation to be complete.

```c
ot_scene_frame_request frame = {
    .struct_size = sizeof(frame), .abi_version = OT_CONTEXT_ABI_VERSION,
};
ot_status status = ot_scene_paint(context, &session, background, 0, 0, &frame);
if (status != OT_OK) return status;
uint32_t result;
status = ot_scene_frame_commit(context, &session, &frame, 0, &result);
if (status != OT_OK) {
    /* Admission failed. This host abandons the draft instead of retrying it. */
    ot_scene_frame_cancel(context, &session, frame.frame_id);
    return status;
}
/* The draft is consumed. Handle result before starting another paint. */
```

The C return value and render result answer different questions:

| Commit result                            | Draft consumed? | Output accepted?       | Presentation complete? |
| ---------------------------------------- | --------------- | ---------------------- | ---------------------- |
| `OT_OK` + `OT_RENDER_PRESENTED`          | Yes             | Yes, possibly no bytes | Yes                    |
| `OT_OK` + `OT_RENDER_PENDING`            | Yes             | Yes                    | No                     |
| `OT_OK` + `OT_RENDER_SKIPPED`            | Yes             | No                     | No new presentation    |
| `OT_OK` + `OT_RENDER_FAILED`             | Yes             | No                     | No new presentation    |
| Admission error, such as `OT_FRAME_BUSY` | No              | No                     | No new presentation    |

An admission error preserves a live draft for retry after you resolve the error.
It cannot restore a draft that was already stale or cancelled. `SKIPPED` means you
must wait for output capacity, then paint a new draft. `FAILED` also requires a new
paint; pumping does not retry encoding. For `PENDING`, copy output with
`ot_session_read_output`, deliver every copied byte, and acknowledge its ticket
with `ot_session_complete_output`. Only completed presentation publishes new hits
and frame statistics.

Zig uses `scenePaint` → `sceneFrameCommit` → `readOutput`/`completeOutput`.
TypeScript's `NativeScene.paint()` and `commit()` follow the same lifecycle, including
clearing consumed drafts on every returned status. Rust's `Session::paint` returns
an opaque `PaintedFrame`; `commit` consumes it on `Ok`, and dropping an unsubmitted
draft cancels it. Split submissions with a draft follow the same consumption rules.

Immediate drawing uses `ot_session_render` when no scene draft is live. Its
`PENDING` result can refer to an earlier submission, in which case it accepts no
new drawing. Null-frame split submissions follow that same pending-output rule.
Offscreen buffers need no submission until you compose them into a frame or snapshot.

## ABI generation and builds

Use matching C headers and libraries. Initialize each versioned record's exact
`struct_size` and `abi_version`, and leave unused flags and reserved fields zero.
Follow the header's per-operation output and failure contracts.

From `packages/core`:

```sh
bun run generate:abi
bun run check:abi
bun run test:abi
```

[`scripts/native-abi.ts`](../core/scripts/native-abi.ts) uses Zig Translate-C and
[`scripts/native-abi.zig`](../core/scripts/native-abi.zig) reflection to derive scalar
widths, signatures, callback types, constants, record sizes, alignment, and field
offsets from the header. Pointer nullability, retention, address fields, and portable
`buffer`/`ptr` policy live in
[`scripts/native-abi-pointers.ts`](../core/scripts/native-abi-pointers.ts), because C
types cannot prove lifetimes. Review that metadata when ownership contracts change.
Do not edit generated bindings. `check:abi` detects stale output; use
`bun run check:abi --all-targets` to compare supported target layouts too.
Unsupported record shapes and calling conventions reject instead of producing
partial metadata. C compiler type assertions also verify complete function and
callback prototypes, because Translate-C can discard callback calling-convention
attributes.

From `packages/native`, `bun run build` installs headers and libraries under
`lib/<target>/`. Linux and macOS produce `libopentui.a` beside the shared library.
Windows produces `opentui-static.lib`, `opentui.lib` for DLL imports, and `opentui.dll`.
Static linkage still requires the relevant platform and C++ runtime libraries.
`zig build -Dall` builds all supported targets; `-Dlibrary-target=<target>` selects one.

```sh
zig build test-abi --summary all
```

This checks C/Zig layouts for all eight supported targets and runs the C fixture with
static and dynamic linking on the host. Linux acceptance targets glibc 2.17.
`zig build test-abi-layout --summary all` runs only layout checks. Cross-target layout
checks do not establish macOS/Windows runtime linkage or terminal behavior.

The external [`examples/hello`](examples/hello) package imports the public Zig module
without JavaScript.

The [`examples/rust`](examples/rust) Cargo crate provides Rust bindings to the checked
C ABI with thread-affine Context, Session, and Node owners. It is an example.
The crate links existing native artifacts without JavaScript or a Zig implementation bridge.
