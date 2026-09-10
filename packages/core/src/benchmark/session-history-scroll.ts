import { performance } from "node:perf_hooks"
import { BoxRenderable } from "../renderables/Box.js"
import { DiffRenderable } from "../renderables/Diff.js"
import { MarkdownRenderable } from "../renderables/Markdown.js"
import { ScrollBoxRenderable } from "../renderables/ScrollBox.js"
import { TextRenderable } from "../renderables/Text.js"
import { SyntaxStyle } from "../syntax-style.js"
import { MockTreeSitterClient } from "../testing/mock-tree-sitter-client.js"
import { createTestRenderer, type TestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"
import type { Renderable } from "../Renderable.js"
import { RGBA } from "../lib/RGBA.js"

// OpenCode session transcript windowing from packages/tui/src/routes/session/index.tsx.
export const TRANSCRIPT_TAIL_ROWS = 40
export const TRANSCRIPT_BACKFILL_CHUNK = 60
export const KEY_REPEAT_HZ = 33

const ACCENT = RGBA.fromInts(84, 171, 224)
const PANEL = RGBA.fromInts(28, 32, 38)
const TEXT = RGBA.fromInts(220, 224, 230)
const SUBDUED = RGBA.fromInts(140, 148, 160)

export type TranscriptBody = "markdown" | "text"
export type TranscriptStart = "bottom" | "top"
export type PageDirection = "up" | "down"
export type StepKind = "scroll" | "backfill"

export interface TranscriptWorkload {
  width: number
  height: number
  totalRows: number
  body: TranscriptBody
  start: TranscriptStart
  contentScale: number
}

export interface FrameTiming {
  elapsedMs: number
  sceneMs: number
  nativeRenderMs: number
  cellsUpdated: number
}

export interface PageStep {
  index: number
  kind: StepKind
  direction: PageDirection
  delta: number
  hidden: number
  mounted: number
  descendants: number
  scrollTop: number
  scrollHeight: number
  viewportHeight: number
  constructMs: number
  frame1: FrameTiming
  frame2: FrameTiming
  compensate: FrameTiming
  totalMs: number
}

export interface TranscriptSession {
  renderer: TestRenderer
  renderOnce: TestRendererSetup["renderOnce"]
  captureCharFrame: TestRendererSetup["captureCharFrame"]
  scroll: ScrollBoxRenderable
  syntaxStyle: SyntaxStyle
  treeSitter: MockTreeSitterClient
  workload: TranscriptWorkload
  hiddenRows: number | undefined
  visibleRowsEnd: number | undefined
  revealingOlderRows: boolean
  revealingNewerRows: boolean
  steps: PageStep[]
  hidden(): number
  visibleEnd(): number
  mountedCount(): number
  descendantCount(): number
  page(direction: PageDirection): Promise<PageStep>
  hold(direction: PageDirection, maxSteps: number): Promise<PageStep[]>
  destroy(): Promise<void>
}

const ZERO_FRAME: FrameTiming = { elapsedMs: 0, sceneMs: 0, nativeRenderMs: 0, cellsUpdated: 0 }

export function defaultWorkload(overrides: Partial<TranscriptWorkload> = {}): TranscriptWorkload {
  return {
    width: 140,
    height: 44,
    totalRows: 400,
    body: "markdown",
    start: "bottom",
    contentScale: 1,
    ...overrides,
  }
}

export function rowKind(index: number): "user" | "assistant" | "tool" {
  const phase = index % 3
  if (phase === 0) return "user"
  if (phase === 1) return "assistant"
  return "tool"
}

export function userText(index: number): string {
  return `User ${index}: page through the native session history without stalling on older turns.`
}

export function assistantMarkdown(index: number, scale: number): string {
  const repeats = Math.max(1, scale)
  const lines = Array.from(
    { length: 8 * repeats },
    (_, line) => `  token${index}_${line}: ${"value ".repeat(6).trim()}`,
  )
  const table = Array.from(
    { length: 3 * repeats },
    (_, row) => `| item ${index}.${row} | ${row % 2 === 0 ? "pending" : "ready"} | \`${index * 10 + row}\` |`,
  )
  return [
    `## Assistant ${index}`,
    "",
    "Older transcript rows mount in chunks when the viewport reaches the current window edge.",
    "",
    "- construct native wrappers",
    "- measure markdown and tables",
    "- paint only the visible region",
    "",
    "```ts",
    `function revealOlderRows(hidden: number): number {`,
    "  return Math.max(0, hidden - 60)",
    "}",
    ...lines,
    "```",
    "",
    "| Step | Status | Detail |",
    "| --- | --- | --- |",
    ...table,
  ].join("\n")
}

export function assistantText(index: number, scale: number): string {
  return Array.from(
    { length: 4 * Math.max(1, scale) },
    (_, line) => `Assistant ${index} line ${line}: native ownership still pays wrapper birth on backfill.`,
  ).join("\n")
}

export function toolText(index: number, scale: number): string {
  return Array.from(
    { length: 3 * Math.max(1, scale) },
    (_, line) => `packages/core/src/session-${index}.ts:${line + 1}  native scene node ${index * 32 + line}`,
  ).join("\n")
}

export function toolDiff(index: number, scale: number): string {
  const changes = Math.max(4, 8 * scale)
  const removed = Array.from({ length: changes }, (_, line) => `-  token${index}_${line}: old`)
  const added = Array.from({ length: changes }, (_, line) => `+  token${index}_${line}: native-owned`)
  return [
    `--- a/src/session-${index}.ts`,
    `+++ b/src/session-${index}.ts`,
    `@@ -1,${changes} +1,${changes} @@`,
    "  export function revealOlderRows(hidden: number) {",
    ...removed,
    ...added,
    "    return Math.max(0, hidden - 60)",
    "  }",
  ].join("\n")
}

export function countDescendants(node: Renderable): number {
  let count = 0
  const stack = node.getChildren().slice()
  while (stack.length > 0) {
    const child = stack.pop()!
    count++
    const children = child.getChildren()
    for (let index = 0; index < children.length; index++) stack.push(children[index]!)
  }
  return count
}

export function summarizeDurations(values: readonly number[]): {
  count: number
  median: number
  p95: number
  max: number
} {
  if (values.length === 0) return { count: 0, median: 0, p95: 0, max: 0 }
  const sorted = values.slice().sort((left, right) => left - right)
  const last = sorted.length - 1
  const percentile = (fraction: number) => sorted[Math.min(last, Math.ceil(fraction * last))]!
  return {
    count: sorted.length,
    median: percentile(0.5),
    p95: percentile(0.95),
    max: sorted[last]!,
  }
}

export function queuedKeyRepeats(durationMs: number, repeatHz = KEY_REPEAT_HZ): number {
  if (durationMs <= 0) return 0
  return Math.floor((durationMs / 1000) * repeatHz)
}

export async function createTranscriptSession(
  workload: TranscriptWorkload = defaultWorkload(),
): Promise<TranscriptSession> {
  if (!Number.isSafeInteger(workload.totalRows) || workload.totalRows < TRANSCRIPT_TAIL_ROWS) {
    throw new Error(`totalRows must be an integer >= ${TRANSCRIPT_TAIL_ROWS}`)
  }
  if (!Number.isSafeInteger(workload.contentScale) || workload.contentScale < 1) {
    throw new Error("contentScale must be an integer >= 1")
  }

  const target = await createTestRenderer({ width: workload.width, height: workload.height })
  const syntaxStyle = SyntaxStyle.fromStyles(
    {
      default: { fg: TEXT },
      "markup.heading": { fg: ACCENT, bold: true },
      "markup.list": { fg: ACCENT },
      "markup.raw": { fg: ACCENT },
      "markup.strong": { bold: true },
    },
    target.renderer.nativeScene,
  )
  const treeSitter = new MockTreeSitterClient()
  treeSitter.setMockResult({ highlights: [] })

  const scroll = new ScrollBoxRenderable(target.renderer, {
    id: "session-history-scroll",
    width: "100%",
    height: "100%",
    flexGrow: 1,
    stickyScroll: true,
    stickyStart: workload.start,
    viewportCulling: true,
  })
  target.renderer.root.add(scroll)

  const session: TranscriptSession = {
    renderer: target.renderer,
    renderOnce: target.renderOnce,
    captureCharFrame: target.captureCharFrame,
    scroll,
    syntaxStyle,
    treeSitter,
    workload,
    hiddenRows: workload.start === "top" ? 0 : undefined,
    visibleRowsEnd: workload.start === "top" ? Math.min(workload.totalRows, TRANSCRIPT_BACKFILL_CHUNK) : undefined,
    revealingOlderRows: false,
    revealingNewerRows: false,
    steps: [],
    hidden: () => hiddenOf(session),
    visibleEnd: () => visibleEndOf(session),
    mountedCount: () => session.visibleEnd() - session.hidden(),
    descendantCount: () => countDescendants(scroll),
    async page(direction) {
      return pageTranscript(session, direction)
    },
    async hold(direction, maxSteps) {
      return holdTranscript(session, direction, maxSteps)
    },
    async destroy() {
      target.renderer.destroy()
      await target.renderer.closed
      syntaxStyle.destroy()
      treeSitter.resolveAllHighlightOnce()
      await treeSitter.destroy()
    },
  }

  mountRange(session, session.hidden(), session.visibleEnd())
  await target.renderOnce()
  if (workload.start === "bottom") {
    scroll.scrollTo(scroll.scrollHeight)
    await target.renderOnce()
  } else {
    scroll.stickyScroll = false
    scroll.scrollTo(0)
    await target.renderOnce()
  }
  return session
}

function hiddenOf(session: TranscriptSession): number {
  return Math.max(
    0,
    Math.min(session.hiddenRows ?? Number.POSITIVE_INFINITY, session.workload.totalRows - TRANSCRIPT_TAIL_ROWS),
  )
}

function visibleEndOf(session: TranscriptSession): number {
  return Math.max(
    hiddenOf(session),
    Math.min(session.visibleRowsEnd ?? session.workload.totalRows, session.workload.totalRows),
  )
}

function mountRange(session: TranscriptSession, start: number, end: number, anchor?: Renderable): void {
  const first = anchor ?? session.scroll.getChildren()[0]
  for (let index = start; index < end; index++) {
    const row = createRow(session, index)
    if (first) session.scroll.insertBefore(row, first)
    else session.scroll.add(row)
  }
}

function appendRange(session: TranscriptSession, start: number, end: number): void {
  for (let index = start; index < end; index++) session.scroll.add(createRow(session, index))
}

function createRow(session: TranscriptSession, index: number): BoxRenderable {
  const kind = rowKind(index)
  const row = new BoxRenderable(session.renderer, {
    id: `session-row-${index}`,
    width: "100%",
    marginTop: 1,
    flexShrink: 0,
    flexDirection: "column",
    paddingLeft: kind === "user" ? 2 : 3,
    border: kind === "user" ? ["left"] : false,
    borderColor: kind === "user" ? ACCENT : undefined,
    backgroundColor: kind === "user" ? PANEL : undefined,
  })
  const { body, contentScale } = session.workload
  if (kind === "user") {
    row.add(new TextRenderable(session.renderer, { content: userText(index), fg: TEXT, wrapMode: "word" }))
    return row
  }
  if (kind === "tool") {
    row.add(
      new TextRenderable(session.renderer, { content: `Edit src/session-${index}.ts`, fg: SUBDUED, wrapMode: "none" }),
    )
    if (body === "text") {
      row.add(
        new TextRenderable(session.renderer, { content: toolText(index, contentScale), fg: TEXT, wrapMode: "word" }),
      )
      return row
    }
    row.add(
      new DiffRenderable(session.renderer, {
        width: "100%",
        diff: toolDiff(index, contentScale),
        view: session.workload.width > 120 ? "split" : "unified",
        filetype: "ts",
        syntaxStyle: session.syntaxStyle,
        treeSitterClient: session.treeSitter,
        showLineNumbers: true,
        wrapMode: "word",
        fg: TEXT,
      }),
    )
    return row
  }
  if (body === "text") {
    row.add(
      new TextRenderable(session.renderer, { content: assistantText(index, contentScale), fg: TEXT, wrapMode: "word" }),
    )
    return row
  }
  row.add(
    new MarkdownRenderable(session.renderer, {
      width: "100%",
      content: assistantMarkdown(index, contentScale),
      syntaxStyle: session.syntaxStyle,
      treeSitterClient: session.treeSitter,
      streaming: false,
      internalBlockMode: "top-level",
      conceal: true,
      tableOptions: { style: "grid", cellPaddingX: 1 },
      fg: TEXT,
      bg: PANEL,
    }),
  )
  return row
}

async function measureFrame(session: TranscriptSession): Promise<FrameTiming> {
  const before = performance.now()
  await session.renderOnce()
  const stats = session.renderer.getNativeStats()
  return {
    elapsedMs: performance.now() - before,
    sceneMs: session.renderer.lastSceneTimeMs,
    nativeRenderMs: (stats.nativeRenderTime ?? 0) / 1000,
    cellsUpdated: stats.cellsUpdated,
  }
}

async function pageTranscript(session: TranscriptSession, direction: PageDirection): Promise<PageStep> {
  const delta = direction === "up" ? -session.scroll.height / 2 : session.scroll.height / 2
  if (delta < 0) {
    const backfill = await revealOlderRows(session, delta)
    if (backfill) return recordStep(session, backfill)
  }
  if (delta > 0) {
    const backfill = await revealNewerRows(session, delta)
    if (backfill) return recordStep(session, backfill)
  }
  const started = performance.now()
  session.scroll.scrollBy(delta)
  const frame1 = await measureFrame(session)
  return recordStep(session, {
    kind: "scroll",
    direction,
    delta,
    constructMs: 0,
    frame1,
    frame2: ZERO_FRAME,
    compensate: ZERO_FRAME,
    totalMs: performance.now() - started,
  })
}

async function revealOlderRows(
  session: TranscriptSession,
  scrollBy: number,
): Promise<Omit<PageStep, "index"> | undefined> {
  const current = session.hidden()
  if (session.revealingOlderRows || session.scroll.scrollTop > session.scroll.viewport.height) return undefined
  if (current === 0) return undefined
  session.revealingOlderRows = true
  session.scroll.stickyScroll = false
  const beforeHeight = session.scroll.scrollHeight
  const nextHidden = Math.max(0, current - TRANSCRIPT_BACKFILL_CHUNK)
  const started = performance.now()
  const first = session.scroll.getChildren()[0]
  mountRange(session, nextHidden, current, first)
  const constructMs = performance.now() - started
  session.hiddenRows = nextHidden
  const frame1 = await measureFrame(session)
  const frame2 = await measureFrame(session)
  const compensateStart = performance.now()
  session.scroll.scrollBy(session.scroll.scrollHeight - beforeHeight + scrollBy)
  const compensate = await measureFrame(session)
  compensate.elapsedMs = performance.now() - compensateStart
  session.scroll.stickyScroll = true
  session.revealingOlderRows = false
  return {
    kind: "backfill",
    direction: "up",
    delta: scrollBy,
    constructMs,
    frame1,
    frame2,
    compensate,
    totalMs: performance.now() - started,
  }
}

async function revealNewerRows(
  session: TranscriptSession,
  scrollBy: number,
): Promise<Omit<PageStep, "index"> | undefined> {
  const current = session.visibleEnd()
  if (
    session.revealingNewerRows ||
    current === session.workload.totalRows ||
    session.scroll.scrollTop + session.scroll.viewport.height <
      session.scroll.scrollHeight - session.scroll.viewport.height
  ) {
    return undefined
  }
  session.revealingNewerRows = true
  const next = Math.min(session.workload.totalRows, current + TRANSCRIPT_BACKFILL_CHUNK)
  const started = performance.now()
  appendRange(session, current, next)
  const constructMs = performance.now() - started
  session.visibleRowsEnd = next === session.workload.totalRows ? undefined : next
  const frame1 = await measureFrame(session)
  const frame2 = await measureFrame(session)
  const compensateStart = performance.now()
  session.scroll.scrollBy(scrollBy)
  const compensate = await measureFrame(session)
  compensate.elapsedMs = performance.now() - compensateStart
  session.revealingNewerRows = false
  return {
    kind: "backfill",
    direction: "down",
    delta: scrollBy,
    constructMs,
    frame1,
    frame2,
    compensate,
    totalMs: performance.now() - started,
  }
}

function recordStep(
  session: TranscriptSession,
  step: Omit<
    PageStep,
    "index" | "hidden" | "mounted" | "descendants" | "scrollTop" | "scrollHeight" | "viewportHeight"
  >,
): PageStep {
  const recorded: PageStep = {
    ...step,
    index: session.steps.length,
    hidden: session.hidden(),
    mounted: session.mountedCount(),
    descendants: session.descendantCount(),
    scrollTop: session.scroll.scrollTop,
    scrollHeight: session.scroll.scrollHeight,
    viewportHeight: session.scroll.viewport.height,
  }
  session.steps.push(recorded)
  return recorded
}

async function holdTranscript(
  session: TranscriptSession,
  direction: PageDirection,
  maxSteps: number,
): Promise<PageStep[]> {
  if (!Number.isSafeInteger(maxSteps) || maxSteps <= 0) throw new Error("maxSteps must be a positive integer")
  const recorded: PageStep[] = []
  let previousTop = session.scroll.scrollTop
  let previousMounted = session.mountedCount()
  for (let step = 0; step < maxSteps; step++) {
    const sample = await session.page(direction)
    recorded.push(sample)
    const atStart = direction === "up" && session.hidden() === 0 && session.scroll.scrollTop <= 0
    const atEnd =
      direction === "down" &&
      session.visibleEnd() === session.workload.totalRows &&
      session.scroll.scrollTop >= Math.max(0, session.scroll.scrollHeight - session.scroll.viewport.height)
    const stalled = sample.kind === "scroll" && sample.scrollTop === previousTop && sample.mounted === previousMounted
    if (atStart || atEnd || stalled) break
    previousTop = sample.scrollTop
    previousMounted = sample.mounted
  }
  return recorded
}
