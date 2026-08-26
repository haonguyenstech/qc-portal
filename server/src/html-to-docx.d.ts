/**
 * `html-to-docx` ships no types. Only the one call shape the portal uses is
 * declared — a wider guess would be a lie the compiler enforces.
 */
declare module 'html-to-docx' {
  export default function HTMLtoDOCX(
    html: string,
    headerHTML?: string | null,
    options?: Record<string, unknown>,
    footerHTML?: string | null,
  ): Promise<Buffer | ArrayBuffer>
}
