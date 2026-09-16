/** Renderer primitives without the full widget, Markdown and audio entrypoint.
 * All exports share identity and native ownership with the main package.
 */
export { createCliRenderer, CliRenderer, MouseEvent, type CliRendererConfig } from "./renderer.js"
export { Renderable, type RenderableOptions } from "./Renderable.js"
export { RGBA, parseColor } from "./lib/RGBA.js"
export { TextAttributes, type RenderContext } from "./types.js"
export { StdinParser, type StdinEvent } from "./lib/stdin-parser.js"
export type { KeyEvent } from "./lib/KeyHandler.js"
export type { OptimizedBuffer } from "./buffer.js"
