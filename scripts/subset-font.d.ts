// subset-font ships no types; this is the one call gen-fonts.ts makes.
declare module "subset-font" {
    export default function subsetFont(
        font: Uint8Array,
        text: string,
        options?: { targetFormat?: "woff2" | "woff" | "truetype" | "sfnt" },
    ): Promise<Uint8Array & { toString(encoding: "base64"): string }>;
}
