import { test } from "bun:test"
import assert from "node:assert/strict"
import { NativeSession } from "../NativeSession.js"
import { RGBA } from "../lib/RGBA.js"
import { createTestRenderer } from "../testing/test-renderer.js"
import { createTestStdout } from "../testing/test-streams.js"
import { NativeStatus } from "../zig.js"

test("NativeScene commit consumes a draft and retries admission errors", async () => {
  const stdout = createTestStdout(4, 1)
  const driver = new NativeSession(stdout, {
    output: { chunkSize: 4096, spanCapacity: 2, maxBytes: 8192n },
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
  const paint = () => scene.paint(0, () => ({ background: RGBA.fromInts(0, 0, 0), useMouse: false, excludedHitNum: 0 }))
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
    await paint()
    const frame = scene.frame!
    const lease = lib.sceneFrameAcquireBufferLease(driver.context, driver.session, frame, "next")
    try {
      assert.throws(() => scene.commit(true), { status: NativeStatus.FrameBusy })
      assert.equal(scene.frame, frame)
    } finally {
      lib.contextReleaseBufferLease(driver.context, lease.handle)
    }
    scene.commit(true)
    assert.equal(scene.frame === null, true)
    assert.throws(() => scene.commit(true), /no painted frame/)
    assert.throws(() => lib.sceneFrameCommit(driver.context, driver.session, frame, true), {
      status: NativeStatus.StaleFrame,
    })
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
