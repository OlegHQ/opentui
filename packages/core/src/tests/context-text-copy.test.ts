import { spyOn, test } from "bun:test"
import assert from "node:assert/strict"
import { ResourceContext } from "../buffer.js"
import { TextBuffer } from "../text-buffer.js"
import { TextBufferView } from "../text-buffer-view.js"
import { EditBuffer } from "../edit-buffer.js"
import { EditorView } from "../editor-view.js"
import { resolveRenderLib } from "../zig.js"

test("small text selections allocate only selected UTF-8 bytes across document and editor views", () => {
  const owner = new ResourceContext({ objectCapacity: 16, renderCellsMax: 128 })
  const symbols = (resolveRenderLib() as any).opentui.symbols
  const textCopy = spyOn(symbols, "ot_text_buffer_view_get_selected_text")
  const editorCopy = spyOn(symbols, "ot_editor_view_get_selected_text")
  const rangeCopy = spyOn(symbols, "ot_text_buffer_get_range")
  try {
    const document = "prefix\n中\tend\n" + "x".repeat(65_536)
    const text = TextBuffer.create("unicode", owner)
    const view = TextBufferView.create(text)
    const edit = EditBuffer.create("unicode", owner)
    const editor = EditorView.create(edit, 20, 2)
    text.setText(document)
    edit.setText(document)
    view.setSelection(7, 9)
    editor.setSelection(7, 9)
    assert.equal(view.getSelectedText(), "中")
    assert.equal(editor.getSelectedText(), "中")
    assert.equal(text.getTextRange(7, 9), "中")
    for (const copy of [textCopy, editorCopy]) {
      assert.deepEqual(
        copy.mock.calls.map((args) => args[3]),
        [0, 3],
      )
      assert.equal((copy.mock.calls[1][2] as Uint8Array).byteLength, 3)
    }
    assert.deepEqual(
      rangeCopy.mock.calls.map((args) => args[5]),
      [0, 3],
    )
    assert.equal((rangeCopy.mock.calls[1][4] as Uint8Array).byteLength, 3)
  } finally {
    textCopy.mockRestore()
    editorCopy.mockRestore()
    rangeCopy.mockRestore()
    owner.destroy()
  }
})
