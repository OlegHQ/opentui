import stringWidthLib from "string-width"
import stripAnsiLib from "strip-ansi"

export const stringWidth: (text: string) => number = stringWidthLib
export const stripANSI: (text: string) => string = stripAnsiLib
