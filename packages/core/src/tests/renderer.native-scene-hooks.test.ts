import { afterEach, expect, spyOn, test } from "bun:test"
import { NativeScene } from "../NativeScene.js"
import { getYogaNode } from "../lib/renderable-layout.js"
import { Renderable } from "../Renderable.js"
import type { OptimizedBuffer } from "../buffer.js"
import { RGBA } from "../lib/RGBA.js"
import { BoxRenderable } from "../renderables/Box.js"
import { TextRenderable } from "../renderables/Text.js"
import { SliderRenderable } from "../renderables/Slider.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"

const setups: TestRendererSetup[] = []
afterEach(async () => {
  for (const { renderer } of setups.splice(0)) {
    renderer.destroy()
    await renderer.closed
  }
})

async function setup() {
  const result = await createTestRenderer({ width: 12, height: 4, clock: new ManualClock(), maxFps: 1000 })
  setups.push(result)
  return result
}

const hookNames = ["selectable", "onLifecyclePass", "renderBefore", "renderAfter"] as const

test("box and text keep hook accessors on the prototype", async () => {
  const { renderer } = await setup()
  const box = new BoxRenderable(renderer, { width: 2, height: 1 })
  const text = new TextRenderable(renderer, { content: "hi", width: 2, height: 1 })

  for (const name of hookNames) {
    expect(Object.hasOwn(box, name)).toBe(false)
    expect(Object.hasOwn(text, name)).toBe(false)
    expect(typeof Object.getOwnPropertyDescriptor(Renderable.prototype, name)?.get).toBe("function")
  }

  expect<object>(getYogaNode(box)).toBe(box)
  expect<object>(getYogaNode(text)).toBe(text)
  expect(box.selectable).toBe(false)
  expect(box.renderBefore).toBeUndefined()
  expect(box.renderAfter).toBeUndefined()
  expect(box.onLifecyclePass).toBeNull()
})

test("leaf box, text, and slider constructors skip deferred hook discovery", async () => {
  const { renderer } = await setup()
  const scan = spyOn(NativeScene.prototype, "scheduleHookScan")
  try {
    new BoxRenderable(renderer, { width: 2, height: 1 })
    new TextRenderable(renderer, { content: "hi", width: 2, height: 1 })
    new SliderRenderable(renderer, { width: 2, height: 1, orientation: "horizontal" })
    expect(scan).not.toHaveBeenCalled()

    class GrowsHooks extends BoxRenderable {}
    new GrowsHooks(renderer, { width: 2, height: 1 })
    expect(scan).toHaveBeenCalledTimes(1)
  } finally {
    scan.mockRestore()
  }
})

test("option and assigned paint hooks still run without own accessors", async () => {
  const { renderer, renderOnce, captureCharFrame } = await setup()
  const color = RGBA.fromInts(255, 255, 255)
  const box = new BoxRenderable(renderer, {
    width: 3,
    height: 1,
    renderBefore(buffer) {
      buffer.drawText("AB", this.x, this.y, color)
    },
  })
  renderer.root.add(box)
  await renderOnce()
  expect(captureCharFrame().split("\n")[0]!.trimEnd()).toBe("AB")

  box.renderAfter = function (buffer) {
    buffer.drawText("C", this.x + 2, this.y, color)
  }
  box.requestRender()
  await renderOnce()
  expect(captureCharFrame().split("\n")[0]!.trimEnd()).toBe("ABC")
})

test("Object.assign onUpdate publishes without an instance accessor", async () => {
  const { renderer, renderOnce } = await setup()
  const box = new BoxRenderable(renderer, { width: 2, height: 1 })
  const calls: string[] = []
  Object.assign(box, { onUpdate: () => calls.push("update") })
  renderer.root.add(box)
  await renderOnce()
  expect(calls).toEqual(["update"])
})

test("destroy skips layout reads unless selection needs local coordinates", async () => {
  const { renderer, renderOnce } = await setup()
  const box = new BoxRenderable(renderer, { width: 2, height: 1, left: 3, top: 1 })
  const selected = new TextRenderable(renderer, {
    content: "hi",
    width: 2,
    height: 1,
    left: 4,
    top: 2,
    position: "absolute",
  })
  const idle = new TextRenderable(renderer, {
    content: "no",
    width: 2,
    height: 1,
    selectable: false,
    left: 5,
    top: 3,
    position: "absolute",
  })
  renderer.root.add(box)
  renderer.root.add(selected)
  renderer.root.add(idle)
  await renderOnce()

  const getLayout = spyOn(renderer.nativeScene, "getLayout")
  box.destroy()
  expect(getLayout).not.toHaveBeenCalled()

  idle.destroy()
  expect(getLayout).not.toHaveBeenCalled()

  const left = selected.x
  selected.destroy()
  expect(getLayout).toHaveBeenCalled()
  expect(selected.x).toBe(left)
})

test("idle nodes do not keep a local geometry copy", async () => {
  const { renderer, renderOnce } = await setup()
  const box = new BoxRenderable(renderer, { width: 4, height: 2, left: 1, top: 1, position: "absolute" })
  renderer.root.add(box)
  await renderOnce()
  expect(box.x).toBe(1)
  expect(box.y).toBe(1)
  expect(box.width).toBe(4)
  expect(box.height).toBe(2)
  box.destroy()
  expect(box.width).toBe(4)
})

test("an explicit extension paints a native box without built-in inheritance or deferred discovery", async () => {
  const { renderer, renderOnce, captureCharFrame } = await setup()
  class NativePanel extends Renderable {
    static override readonly nativeIntegration = this.defineNativeIntegration({
      kind: "box",
      body: { native: this.prototype.renderSelf },
      construction: "prototype",
    })

    protected override renderSelf(): void {
      throw new Error("The native body must not call the host implementation")
    }
  }
  const scan = spyOn(renderer.nativeScene, "scheduleHookScan")
  const discover = spyOn(Renderable.prototype, "_scanNativeSceneHooks")
  const lib = renderer.nativeScene.driver.renderLib
  const step = spyOn(lib, "sceneFrameStep")
  try {
    const panel = new NativePanel(renderer, { width: 5, height: 3 })
    renderer.nativeScene.setPaint(panel, {
      ...panel["getNativeScenePaint"](),
      border: 15,
    })
    renderer.root.add(panel)
    await renderOnce()
    expect(
      captureCharFrame()
        .split("\n")
        .slice(0, 3)
        .map((line) => line.trimEnd()),
    ).toEqual(["┌───┐", "│   │", "└───┘"])
    await renderOnce()
    expect(scan).not.toHaveBeenCalled()
    expect(discover).not.toHaveBeenCalled()
    expect(step).toHaveBeenCalledTimes(2)
  } finally {
    scan.mockRestore()
    discover.mockRestore()
    step.mockRestore()
  }
})

test("explicit host integration shares measurement, lifecycle, paint hooks, and live replacement", async () => {
  const { renderer, renderOnce, captureCharFrame } = await setup()
  const calls: string[] = []
  const color = RGBA.fromInts(255, 255, 255)
  class HostPanel extends Renderable {
    static override readonly nativeIntegration = this.defineNativeIntegration({
      kind: "custom",
      body: "host",
      lifecycle: { update: "host", resize: "host" },
      beforeAfter: true,
      construction: "prototype",
      measure() {
        calls.push(`measure:${this.id}`)
        return { width: 3, height: 1 }
      },
    })

    protected override renderSelf(buffer: OptimizedBuffer): void {
      super.renderSelf(buffer, 0)
      calls.push("self")
      buffer.drawText("B", this.x + 1, this.y, color)
    }

    protected override onUpdate(): void {
      calls.push("update")
    }

    protected override onResize(): void {
      calls.push("resize")
    }
  }
  const panel = new HostPanel(renderer, {
    id: "host",
    alignSelf: "flex-start",
    renderBefore(buffer) {
      calls.push("before")
      buffer.drawText("A", this.x, this.y, color)
    },
    renderAfter(buffer) {
      calls.push("after")
      buffer.drawText("C", this.x + 2, this.y, color)
    },
  })
  panel.onLifecyclePass = () => calls.push("lifecycle")
  renderer.root.add(panel)
  await renderOnce()
  expect(panel.width).toBe(3)
  expect(panel.height).toBe(1)
  expect(calls).toContain("measure:host")
  expect(calls.filter((call) => !call.startsWith("measure:"))).toEqual([
    "lifecycle",
    "resize",
    "update",
    "before",
    "self",
    "after",
  ])
  expect(captureCharFrame().split("\n")[0]!.trimEnd()).toBe("ABC")

  const originalBody = panel["renderSelf"]
  Object.assign(panel, { renderSelf: (buffer: OptimizedBuffer) => buffer.drawText("D", panel.x + 1, panel.y, color) })
  panel.renderAfter = (buffer) => buffer.drawText("E", panel.x + 2, panel.y, color)
  await renderOnce()
  expect(captureCharFrame().split("\n")[0]!.trimEnd()).toBe("ADE")
  panel["renderSelf"] = originalBody
  await renderOnce()
  expect(captureCharFrame().split("\n")[0]!.trimEnd()).toBe("ABE")
})

test("native body assignments publish before attachment and can restore native drawing", async () => {
  const { renderer, renderOnce, captureCharFrame } = await setup()
  const slider = new SliderRenderable(renderer, { width: 2, height: 1, orientation: "horizontal" })
  const nativeBody = slider["renderSelf"]
  Object.assign(slider, {
    renderSelf(this: Renderable, buffer: OptimizedBuffer) {
      buffer.drawText("X", this.x, this.y, RGBA.fromInts(255, 255, 255))
    },
  })
  renderer.root.add(slider)
  await renderOnce()
  expect(captureCharFrame().split("\n")[0]!.trimEnd()).toBe("X")
  slider["renderSelf"] = nativeBody
  const hook = spyOn(slider, "_runNativeSceneHook")
  try {
    await renderOnce()
    expect(captureCharFrame()).not.toContain("X")
    expect(hook).not.toHaveBeenCalled()
  } finally {
    hook.mockRestore()
  }
})

test("disabling extension decorations preserves buffered body drawing and resize notifications", async () => {
  const { renderer, renderOnce, captureCharFrame } = await setup()
  let resized = 0
  class BodyOnly extends Renderable {
    static override readonly nativeIntegration = this.defineNativeIntegration({
      kind: "custom",
      body: "host",
      beforeAfter: false,
      construction: "prototype",
    })

    protected override renderSelf(buffer: OptimizedBuffer): void {
      expect(buffer).toBe(this.frameBuffer!)
      buffer.drawText("X", 0, 0, RGBA.fromInts(255, 255, 255))
    }
  }
  const node = new BodyOnly(renderer, {
    width: 2,
    height: 1,
    buffered: true,
    onSizeChange: () => resized++,
    renderBefore: () => {
      throw new Error("disabled before hook")
    },
    renderAfter: () => {
      throw new Error("disabled after hook")
    },
  })
  renderer.root.add(node)
  await renderOnce()
  node.width = 3
  await renderOnce()
  expect(resized).toBe(1)
  expect(captureCharFrame().split("\n")[0]!.trimEnd()).toBe("X")
})

test("explicit field integration survives intermediate attachment and keeps super drawing order", async () => {
  const { renderer, renderOnce, captureCharFrame } = await setup()
  const calls: string[] = []
  class Attached extends BoxRenderable {
    constructor(...args: ConstructorParameters<typeof BoxRenderable>) {
      super(...args)
      renderer.root.add(this)
      this.refreshHooks()
    }
  }
  const Fields = new Function(
    "Base",
    "calls",
    "white",
    `return class extends Base {
    static nativeIntegration = this.defineNativeIntegration({
      ...Base.nativeIntegration,
      construction: "fields",
    })
    onLifecyclePass = () => calls.push("lifecycle")
    renderSelf = (buffer) => {
      calls.push("self")
      buffer.drawText("before", this.x, this.y, white)
      super.renderSelf(buffer)
      buffer.drawText("X", this.x + 1, this.y + 1, white)
    }
  }`,
  )(Attached, calls, RGBA.fromInts(255, 255, 255)) as typeof Attached
  const box = new Fields(renderer, { width: 5, height: 3, border: true, shouldFill: true })
  await renderOnce()
  expect(calls).toEqual(["lifecycle", "self"])
  expect(
    captureCharFrame()
      .split("\n")
      .slice(0, 3)
      .map((line) => line.trimEnd()),
  ).toEqual(["┌───┐e", "│X  │", "└───┘"])
  box.onLifecyclePass = null
  box["renderSelf"] = BoxRenderable.prototype["renderSelf"]
  calls.length = 0
  await renderOnce()
  expect(calls).toEqual([])
  expect(captureCharFrame()).not.toContain("X")
})
