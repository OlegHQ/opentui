# Host I/O and time

Checked Contexts use the host event loop for scheduling, terminal input, and
terminal output. Native code retains rendering state and performs supported
resource operations through the Context's `std.Io`. These are separate duties:
injecting Context I/O does not install a terminal transport or an event loop.

| Owner           | Contract                                                                                                                                                 |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host scheduler  | Schedules later turns, supplies monotonic Session time, and honors lifecycle waits.                                                                      |
| Host input      | Delivers terminal input and parsed capability or Kitty replies through checked operations.                                                               |
| Host output     | Copies ordered Session output, handles partial transport writes, and completes each output ticket.                                                       |
| Context I/O     | Supplies native file operations, entropy, and diagnostic clock samples. The host keeps its I/O implementation alive until Context destruction completes. |
| Native renderer | Lays out, draws, encodes output, and owns temporary Kitty files until release.                                                                           |

## One Session deadline clock

`ot_session_pump` and `ot_session_poll_kitty_image_transport` take unsigned
64-bit nanoseconds from the same host clock. Equal samples are valid; a
backwards sample returns `OT_INVALID_ARGUMENT` before expiry or Kitty retries.
Sessions have independent clocks. Cursor waits start when a pump observes
completed output; range exhaustion rejects the pump. `pump_exit` bypasses cursor
waits without advancing the clock or skipping output completion.

Kitty file leases start their five-second deadline on the first accepted pump or
poll after creation, saturating at `UINT64_MAX`. An old sample never shortens a
new lease. Each call checks at most eight leases, including while output is
pending. `WAIT_UNTIL` does not schedule Kitty cleanup. Polling advances file
expiry without terminal lifecycle or output. TypeScript passes
`NativeSession.scheduler.now()` (default `process.hrtime.bigint()`) to both
operations; `CliRenderer.Clock` only sets the one-second poll cadence.

## Native files and cleanup

The renderer receives the Context's I/O at attachment and supplies it to Kitty
transport. Temporary-file creation, streaming writes, closes, entropy reads, and
unlinks all use that I/O. The renderer also uses it for hit-grid dumps. Supported
text-resource file operations already use the same Context dependency.

Kitty file transport retains at most eight files and 64 MiB per renderer. Files
use exclusive creation, mode `0600`, and the renderer's explicit `TMPDIR` hint
(otherwise `/tmp` on supported systems). Preparation and output failures close
open files and attempt to unlink leases. Matching acknowledgements, cancellation,
suspension, output failure, and renderer teardown also attempt release. Expiry
cancels file transport; it never claims that the terminal consumed the file.

A failed unlink keeps the path and byte charge while the renderer lives. Expiry
and teardown retry it. Teardown makes a final best-effort attempt; a filesystem
that continues to reject deletion can leave a file behind. Context I/O calls can
block or fail: the lease-count bound is a work-count bound, not an elapsed-time
guarantee.

## Native clock samples

Native renderer timing still samples the Context I/O awake clock for render
statistics and the optional debug overlay. Real-time samples name hit-grid dumps
and salt renderer image IDs. These samples do not schedule host work or decide
checked Session lifecycle waits or Kitty expiry. Diagnostic values and image IDs
can therefore differ between otherwise identical manually driven runs.

Raw `CliRenderer` use is a separate compatibility contract. By default it samples
its supplied I/O awake clock at file creation and during Kitty polling, and retains its synchronous
terminal-restoration path. Context attachment selects host-driven deadlines.
The standalone `Transport` primitive requires explicit I/O and explicit `expire`
calls; it never obtains root I/O or samples a clock itself.

The C Context constructor uses the library's I/O implementation. Direct Zig
`Context.init(allocator, io, options)` supports injection. Compatibility audio,
local clipboard, and other non-Context services retain their own runtime boundary.
