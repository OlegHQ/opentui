# Ownership and observations

The checked API uses three identities: a Context owns resources, a Session owns
presentation and its scene, and a frame request grants temporary drawing or
acknowledgement authority. Resource handles include a Context identity, slot,
and generation. A matching slot alone does not identify a resource.

Use the [checked header](../include/opentui.h) for record layouts, selectors,
limits, and operation-specific failure results. Use matching headers and native
artifacts; the ABI is experimental.

## Resource bindings

Tree membership, resource ownership, and retention are separate relationships.

| Relationship                   | Retention and destruction                                                                                                                                                           | Sharing and layout                                                                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Parent node → child            | Destroying the parent detaches surviving children. It does not destroy the subtree.                                                                                                 | Nodes belong to one Session. Reparenting stays within that scene.                                                                               |
| Session → nodes                | Session destruction destroys all its nodes, including detached nodes.                                                                                                               | A Session has one implicit scene.                                                                                                               |
| Text/edit document → views     | Document destruction destroys every dependent view. Destroying a view leaves the document alive.                                                                                    | A document can supply separate views in multiple Sessions of the same Context.                                                                  |
| Node → text/editor view        | A binding does not transfer ownership. Destroying either side removes the binding. Destroying the view invalidates the node's measurement and preparation state.                    | One view binds to at most one node. The node supplies its layout dimensions to the view. Use separate views for independently sized placements. |
| Node → image/offscreen surface | The binding retains the resource independently of its public handle. Replacement retains the new resource before releasing the previous one. Node destruction releases the binding. | Compatible nodes in multiple Sessions can share a resource within the same Context.                                                             |
| Document → syntax style        | The document observes style destruction and clears its binding. It does not own the public style handle.                                                                            | Documents in the same Context can use one style. Style IDs remain local to that style.                                                          |
| Box → viewport node            | The Box copies a handle without retaining the node. Destroying the viewport makes later preparation fail until the binding is replaced or disabled.                                 | The viewport must satisfy the checked same-scene Box topology rules.                                                                            |
| Lease → buffer storage         | A lease retains one allocation, including after resize or replacement. Release even a stale lease before Context teardown.                                                          | Storage lifetime does not grant frame authority or freeze contents.                                                                             |

Context-owned resources do not require a Session or terminal. Scene-node handles
and frame requests carry additional authority; they cannot substitute for
resource handles. Native ownership checks apply to all bindings, including those
made by direct Zig callers.

TypeScript resource factories accept a `NativeResourceOwner` and retain its
canonical `resourceContext`. A root `NativeSession` owns that Context, and
detached Sessions share it. Resource wrappers remain usable after their
originating detached Session is destroyed, until the resource or Context is
destroyed. Explicit resource destruction also removes its event subscriptions.

## Mutation visibility

Application state passes through distinct stages:

```text
requested host values → staged mutations → accepted native state
    → completed layout → prepared paint membership → painted draft
    → admitted output → transport-completed presentation
```

A property getter can expose a requested value before native acceptance.
Geometry getters expose completed native observations. Reading a layout property
can flush staged mutations without running Yoga; a new requested width therefore
does not imply a new computed width.

Property updates use one bounded stream. Layout and translation writes retain
order. A translation update can merge only into the last record: its prepared
coordinates depend on previously accepted ancestor translations. Other visual
writes coalesce at the node's latest visual record, with the last write winning for each
selected field. Unselected fields keep their accepted native values.
A flush applies records in stream order without calling host code between them.
Each record publishes atomically, including border appearance and Yoga widths.

Topology and immediate resource replacements publish host projections after
native acceptance. A property flush can accept a prefix before rejecting an
entry. The consumed prefix counts records, not bytes. The driver removes that
prefix and retains the rejected entry and suffix for retry. A successful flush
ends the coalescing window. Frame cancellation does not undo accepted mutations
or host callback effects.

The TypeScript driver owns flush boundaries, including cross-scene visibility
before synchronous measurement callbacks. React and Solid use Renderable
operations through that driver. Frameworks do not maintain another acceptance
protocol.

Deferred callback errors can surface after a successful native mutation and host
publication. A thrown host error alone does not establish native rejection.

## Text and copied observations

Documents, views, and placements have different jobs. Documents own text. Views
own wrapping, viewport, and selection state. Scene nodes place and measure views.
An ordinary TEXT node owns a private document/view pair; a TEXT_VIEW or EDITOR
node binds a public view.

Text and selected-text copies use UTF-8 byte counts. Zero capacity queries the
exact count, with no terminating NUL. A short nonzero output rejects before
writing bytes or the output count. Record queries count records. Output and
diagnostic queues document their own draining behavior.

Text range offsets and columns are display cells, including one cell per LF.
Range starts snap backward to the containing grapheme, and exclusive ends snap
forward to include a partially selected grapheme. Byte counts, display cells,
code points, and graphemes are not interchangeable.

Selected-text reads do not prepare virtual lines or follow the cursor.
Coordinate-based edit ranges can prepare the document's marker cache. View line
queries can prepare wrapping, and editor info queries follow the cursor only
when explicitly requested.

## Painted drafts and submission

`scenePaint` and `ot_scene_paint` return the same `DONE` request as incremental
frame stepping. The Session retains one painted draft until it is submitted or
cancelled. Use the exact issued request for acknowledgement and submission,
including its identities, generations, and dimensions. Separate geometry queries
provide observations without granting authority.

Normal and frame-qualified split commits consume that draft on every returned
render status: `PRESENTED`, `PENDING`, `SKIPPED`, and `FAILED`. An admission error
preserves the draft for retry. A consumed draft is stale even if earlier output
remains pending. Output delivery and presentation completion remain separate
from draft consumption.

TypeScript treats issued authority fields as readonly. Rust represents the draft
as an opaque `PaintedFrame`, consumes it on successful submission, and cancels an
unsubmitted draft when it is dropped.

## Drawing and storage access

Checked drawing targets an owned offscreen buffer or a Session's next buffer
with an issued active paint request or completed draft. A Session handle alone
does not grant checked drawing access. `YIELD` grants neither drawing nor commit
authority.

Prefer checked drawing methods for text, cells, composition, and bulk data.
Acquire a scoped lease when an effect needs cell planes. Lazy acquisition lets
host hooks that use only checked drawing avoid raw storage access entirely.
Saved array aliases become invalid when the lease is released.

The current buffer is the encoder's comparison storage, not a guaranteed
last-presented snapshot. The next buffer is drawing storage and can be cleared
after encoding. Only transport-completed presentation publishes the new hit
grid; pending or failed output retains the previous published state.
