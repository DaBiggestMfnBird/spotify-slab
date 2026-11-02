import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const options = {
    entryPoints: ["src/main.ts"],
    bundle: true,
    format: "iife",
    target: ["es2020"],
    outfile: "dist/slab.js",
    minify: false,
    sourcemap: false,
    legalComments: "none",
    banner: { js: "/* SLAB — Third Coast playback moods */" },
};

if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log("SLAB: watching src/ …");
} else {
    const result = await esbuild.build({ ...options, metafile: true });
    const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
    console.log(`SLAB: built dist/slab.js (${(bytes / 1024).toFixed(1)} kB)`);
}
