import type { Lexer } from "marked"

/** Keep Markdown's parser initialization out of applications that only use other widgets. */
export function getMarkdownLexer(): typeof Lexer {
  return require("marked").Lexer
}
