import { expect, test } from "bun:test"
import { getYogaNode } from "../lib/renderable-layout.js"
import { BoxRenderable } from "../renderables/Box.js"
import { createTestRenderer, ManualClock } from "../testing.js"

test("unprepared dimensions follow numeric styles until layout publishes geometry", async () => {
  const { renderer, renderOnce } = await createTestRenderer({ width: 12, height: 4, clock: new ManualClock() })
  try {
    const parent = new BoxRenderable(renderer, { width: 10, height: 4, visible: false })
    const child = new BoxRenderable(renderer, { height: 1 })
    parent.add(child)
    renderer.root.add(parent)

    child.width = 4
    child.height = 2
    await renderOnce()
    const unprepared = renderer.nativeScene.getLayout(getYogaNode(child))
    expect([unprepared.width, unprepared.height]).toEqual([0, 0])
    expect([child.width, child.height]).toEqual([4, 2])

    child.width = "50%"
    child.height = "auto"
    expect([child.width, child.height]).toEqual([0, 0])

    child.width = 4
    child.height = 2
    parent.visible = true
    await renderOnce()
    expect([child.width, child.height]).toEqual([4, 2])

    child.width = 6
    child.height = 1
    expect([child.width, child.height]).toEqual([4, 2])
    await renderOnce()
    expect([child.width, child.height]).toEqual([6, 1])
  } finally {
    renderer.destroy()
    await renderer.closed
  }
})
