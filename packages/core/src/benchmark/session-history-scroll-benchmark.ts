#!/usr/bin/env bun

import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

import {
  createTranscriptSession,
  defaultWorkload,
  queuedKeyRepeats,
  summarizeDurations,
  type PageStep,
  type TranscriptBody,
  type TranscriptStart,
  type TranscriptWorkload,
} from "./session-history-scroll.js"

interface BenchmarkArgs {
  width: number
  height: number
  rows: number
  body: TranscriptBody
  start: TranscriptStart
  contentScale: number
  maxSteps: number
  jsonPath?: string
  output: boolean
}

function parseNumber(value: string | undefined, fallback: number, minimum: number): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`invalid numeric argument: ${value}`)
  }
  return parsed
}

function parseArgs(argv: string[]): BenchmarkArgs {
  let width = 140
  let height = 44
  let rows = 400
  let body: TranscriptBody = "markdown"
  let start: TranscriptStart = "bottom"
  let contentScale = 1
  let maxSteps = 80
  let jsonPath: string | undefined
  let output = true

  for (const arg of argv) {
    if (arg === "--no-output") {
      output = false
      continue
    }
    if (arg === "--json") {
      jsonPath = "latest-session-history-scroll.json"
      continue
    }
    if (arg.startsWith("--json=")) {
      jsonPath = arg.slice("--json=".length)
      continue
    }
    if (arg.startsWith("--width=")) {
      width = parseNumber(arg.slice("--width=".length), width, 40)
      continue
    }
    if (arg.startsWith("--height=")) {
      height = parseNumber(arg.slice("--height=".length), height, 20)
      continue
    }
    if (arg.startsWith("--rows=")) {
      rows = parseNumber(arg.slice("--rows=".length), rows, 40)
      continue
    }
    if (arg.startsWith("--max-steps=")) {
      maxSteps = parseNumber(arg.slice("--max-steps=".length), maxSteps, 1)
      continue
    }
    if (arg.startsWith("--content-scale=")) {
      contentScale = parseNumber(arg.slice("--content-scale=".length), contentScale, 1)
      continue
    }
    if (arg.startsWith("--body=")) {
      const value = arg.slice("--body=".length)
      if (value !== "markdown" && value !== "text") throw new Error(`invalid --body=${value}`)
      body = value
      continue
    }
    if (arg.startsWith("--start=")) {
      const value = arg.slice("--start=".length)
      if (value !== "bottom" && value !== "top") throw new Error(`invalid --start=${value}`)
      start = value
      continue
    }
    throw new Error(`unknown argument: ${arg}`)
  }

  return { width, height, rows, body, start, contentScale, maxSteps, jsonPath, output }
}

function ms(value: number): string {
  return value.toFixed(2).padStart(8)
}

function printSteps(steps: readonly PageStep[]): void {
  console.log(
    "step  kind      dir  mounted  nodes   construct  frame1    scene1    native1   frame2    compensate  total     queued33",
  )
  for (const step of steps) {
    console.log(
      [
        String(step.index).padStart(4),
        step.kind.padEnd(9),
        step.direction.padEnd(3),
        String(step.mounted).padStart(7),
        String(step.descendants).padStart(6),
        ms(step.constructMs),
        ms(step.frame1.elapsedMs),
        ms(step.frame1.sceneMs),
        ms(step.frame1.nativeRenderMs),
        ms(step.frame2.elapsedMs),
        ms(step.compensate.elapsedMs),
        ms(step.totalMs),
        String(queuedKeyRepeats(step.totalMs)).padStart(8),
      ].join("  "),
    )
  }
}

function printGroup(label: string, steps: readonly PageStep[], field: (step: PageStep) => number): void {
  const stats = summarizeDurations(steps.map(field))
  if (stats.count === 0) {
    console.log(`${label}: none`)
    return
  }
  console.log(
    `${label}: n=${stats.count} median=${stats.median.toFixed(2)}ms p95=${stats.p95.toFixed(2)}ms max=${stats.max.toFixed(2)}ms`,
  )
}

function hitchReport(steps: readonly PageStep[]): string[] {
  const scrolls = steps.filter((step) => step.kind === "scroll")
  const backfills = steps.filter((step) => step.kind === "backfill")
  const scrollMedian = summarizeDurations(scrolls.map((step) => step.totalMs)).median
  const lines: string[] = []
  for (const step of backfills) {
    const ratio = scrollMedian > 0 ? step.totalMs / scrollMedian : Infinity
    lines.push(
      `backfill mounted=${step.mounted} total=${step.totalMs.toFixed(2)}ms construct=${step.constructMs.toFixed(2)}ms ` +
        `frame1=${step.frame1.elapsedMs.toFixed(2)}ms scene1=${step.frame1.sceneMs.toFixed(2)}ms ` +
        `native1=${step.frame1.nativeRenderMs.toFixed(2)}ms frame2=${step.frame2.elapsedMs.toFixed(2)}ms ` +
        `compensate=${step.compensate.elapsedMs.toFixed(2)}ms vs-scroll=${ratio.toFixed(1)}x queued@33Hz=${queuedKeyRepeats(step.totalMs)}`,
    )
  }
  return lines
}

async function runCase(
  workload: TranscriptWorkload,
  maxSteps: number,
): Promise<{
  workload: TranscriptWorkload
  initialMounted: number
  initialDescendants: number
  steps: PageStep[]
  hitch: string[]
}> {
  const session = await createTranscriptSession(workload)
  try {
    const initialMounted = session.mountedCount()
    const initialDescendants = session.descendantCount()
    const direction = workload.start === "bottom" ? "up" : "down"
    const steps = await session.hold(direction, maxSteps)
    return {
      workload,
      initialMounted,
      initialDescendants,
      steps,
      hitch: hitchReport(steps),
    }
  } finally {
    await session.destroy()
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const workload = defaultWorkload({
    width: args.width,
    height: args.height,
    totalRows: args.rows,
    body: args.body,
    start: args.start,
    contentScale: args.contentScale,
  })
  const result = await runCase(workload, args.maxSteps)
  if (args.output) {
    console.log(
      `session-history-scroll body=${workload.body} start=${workload.start} rows=${workload.totalRows} ` +
        `${workload.width}x${workload.height} scale=${workload.contentScale}`,
    )
    console.log(`initial mounted=${result.initialMounted} descendants=${result.initialDescendants}`)
    printSteps(result.steps)
    const scrolls = result.steps.filter((step) => step.kind === "scroll")
    const backfills = result.steps.filter((step) => step.kind === "backfill")
    printGroup("scroll total", scrolls, (step) => step.totalMs)
    printGroup("backfill total", backfills, (step) => step.totalMs)
    printGroup("backfill construct", backfills, (step) => step.constructMs)
    printGroup("backfill frame1", backfills, (step) => step.frame1.elapsedMs)
    printGroup("backfill scene1", backfills, (step) => step.frame1.sceneMs)
    printGroup("backfill native1", backfills, (step) => step.frame1.nativeRenderMs)
    printGroup("backfill frame2", backfills, (step) => step.frame2.elapsedMs)
    printGroup("backfill compensate", backfills, (step) => step.compensate.elapsedMs)
    for (const line of result.hitch) console.log(line)
  }
  if (args.jsonPath) {
    const resolved = path.resolve(args.jsonPath)
    const directory = path.dirname(resolved)
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
    writeFileSync(resolved, `${JSON.stringify(result, null, 2)}\n`)
    if (args.output) console.log(`wrote ${resolved}`)
  }
}

await main()
