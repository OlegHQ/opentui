/** Bun supplies these primitives; importing Node fallbacks would initialize unused ICU data. */
export const stringWidth: (text: string) => number = Bun.stringWidth
export const stripANSI: (text: string) => string = Bun.stripANSI
