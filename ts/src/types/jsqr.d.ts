declare module 'jsqr' {
  type DecodedQr = { data: string } | null
  export default function jsQR(data: Uint8ClampedArray, width: number, height: number): DecodedQr
}

declare module 'fontkit' {
  export function openSync(path: string): {
    fonts?: Array<{ hasGlyphForCodePoint?(codePoint: number): boolean }>
    hasGlyphForCodePoint?(codePoint: number): boolean
  }
}
