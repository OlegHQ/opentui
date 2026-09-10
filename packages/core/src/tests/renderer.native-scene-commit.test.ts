import { test } from "bun:test"
import assert from "node:assert/strict"
import { NativeSession } from "../NativeSession.js"
import { RGBA } from "../lib/RGBA.js"
import { createTestRenderer } from "../testing/test-renderer.js"
import { createTestStdout } from "../testing/test-streams.js"
import { NativeSessionRenderStatus, NativeStatus } from "../zig.js"

for (const split of [false, true]) {
  for (const status of [
    NativeSessionRenderStatus.Failed,
    NativeSessionRenderStatus.Skipped,
    NativeSessionRenderStatus.Pending,
    NativeSessionRenderStatus.Presented,
  ]) {
    test(`NativeScene ${split ? "split" : "normal"} commit consumes status ${status} and retries admission errors`, async () => {
      const stdout = createTestStdout(4, 1)
      const driver = new NativeSession(stdout, {
        output:
          status === NativeSessionRenderStatus.Pending || status === NativeSessionRenderStatus.Presented
            ? { chunkSize: 4096, spanCapacity: 2, maxBytes: 8192n }
            : { chunkSize: 32, spanCapacity: 2, maxBytes: 64n },
        scheduler: { now: () => 0n, schedule: () => () => {} },
      })
      const { renderer } = await createTestRenderer({
        width: 4,
        height: 1,
        stdout,
        nativeSession: driver,
        bufferedOutput: "stdout",
      })
      const scene = renderer.nativeScene
      const lib = driver.renderLib
      const paint = () =>
        scene.paint(0, () => ({ background: RGBA.fromInts(0, 0, 0), useMouse: false, excludedHitNum: 0 }))
      const commit = () =>
        split
          ? scene.commitSplit([], 0, status !== NativeSessionRenderStatus.Presented).status
          : scene.commit(status !== NativeSessionRenderStatus.Presented)
      const drain = () => {
        const bytes = new Uint8Array(4096)
        for (let work = 0; work < 32; work++) {
          const ticket = lib.sessionReadOutput(driver.context, driver.session, bytes)
          if (!ticket) return
          lib.sessionCompleteOutput(driver.context, driver.session, ticket, true)
        }
        assert.fail("output did not drain")
      }
      try {
        if (status === NativeSessionRenderStatus.Presented) {
          await paint()
          scene.commit(true)
          drain()
        }
        await paint()
        const frame = scene.frame!
        const lease = lib.sceneFrameAcquireBufferLease(driver.context, driver.session, frame, "next")
        try {
          assert.throws(commit, { status: NativeStatus.FrameBusy })
          assert.equal(scene.frame, frame)
        } finally {
          lib.contextReleaseBufferLease(driver.context, lease.handle)
        }
        if (status === NativeSessionRenderStatus.Skipped) {
          lib.sessionWrite(driver.context, driver.session, new Uint8Array(64).fill(120))
        }
        assert.equal(commit(), status)
        const consumed = scene.frame
        assert.equal(consumed, null)
        assert.throws(commit, /no painted frame/)
        assert.throws(() => lib.sceneFrameCommit(driver.context, driver.session, frame, true), {
          status: NativeStatus.StaleFrame,
        })
        if (status === NativeSessionRenderStatus.Pending) {
          assert.equal(driver.render(true), NativeSessionRenderStatus.Pending)
          assert.throws(paint, { status: NativeStatus.OutputBusy })
          assert.throws(() => driver.renderSplit(frame, [], 0, true), { status: NativeStatus.StaleFrame })
        }
        drain()
        await paint()
        assert.notEqual(scene.frame?.frameId, frame.frameId)
        scene.cancelFrame()
      } finally {
        renderer.destroy()
        driver.dispose()
        await renderer.closed.catch(() => {})
      }
    })
  }
}
