import { Lexer } from "marked"

export function getMarkdownLexer(): typeof Lexer {
  return Lexer
}
