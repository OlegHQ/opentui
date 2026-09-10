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
64-bit nanoseconds from the same host clock. Each Session records its last
accepted sample. Equal samples are valid. A backwards sample returns
`OT_INVALID_ARGUMENT` (`error.InvalidClock` in Zig) before expiring files or
consuming a Kitty retry notification. Different Sessions have independent clocks.

Cursor-restoration waits start when a pump observes completed output. They need
enough remaining clock range for the pending waits; range exhaustion rejects the
pump. A host with no valid later time must cancel the Session. `pump_exit` is the
process-exit restoration fallback: it bypasses cursor waits without advancing the
clock or bypassing output completion.

Kitty file leases start their five-second deadline on the first accepted pump or
Kitty poll after creation. This also works after a long idle interval: an old
sample never shortens a new lease. The deadline saturates at
`UINT64_MAX`. A sample at that deadline expires the lease, including an initial
sample at `UINT64_MAX`. No subtraction, unit conversion, or wrapping arithmetic
decides expiry.

Every accepted pump and Kitty poll checks at most eight leases, including while
terminal output is pending. Pump results describe terminal lifecycle work;
`WAIT_UNTIL` does not schedule Kitty cleanup. Keep polling while files may be
pending, including after switching to an inline image transport. Polling advances
the shared clock and file expiry without advancing terminal lifecycle or
delivering output. Without host calls, native time does not advance these leases.

TypeScript passes `NativeSession.scheduler.now()` to both operations. Its default
is `process.hrtime.bigint()`, on both Bun and Node. `CliRenderer` retains its
one-second Kitty polling interval and existing probe/reply dispatch. The renderer
`Clock` controls that interval's cadence; the Session scheduler supplies its time
sample. A deterministic host injects both when it needs to drive both schedules.

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
