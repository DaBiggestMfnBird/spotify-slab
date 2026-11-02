#!/usr/bin/env node
/**
 * Install SLAB into Spicetify's extension folder, mirror it into the client's
 * own extensions directory, and register it in the config.
 *
 * `spicetify apply` does the mirror step and then restarts Spotify — which
 * drops a `--remote-debugging-port` session. Copying the file ourselves means
 * a reload picks up the new build without losing the debug port.
 */

import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const EXTENSION = "slab.js";
const source = new URL("../dist/slab.js", import.meta.url);

const spicetifyDir = join(homedir(), ".config", "spicetify");
const extensionsDir = join(spicetifyDir, "Extensions");
const configPath = join(spicetifyDir, "config-xpui.ini");

await mkdir(extensionsDir, { recursive: true });
await copyFile(source, join(extensionsDir, EXTENSION));

let config = await readFile(configPath, "utf8");

// Spicetify serves extensions out of the client bundle, so the copy there is
// the one Spotify actually loads.
const spotifyPath = config.match(/^spotify_path\s*=\s*(.*)$/m)?.[1]?.trim();
if (spotifyPath) {
    const clientDir = join(spotifyPath, "Apps", "xpui", "extensions");
    try {
        await access(clientDir);
        await copyFile(source, join(clientDir, EXTENSION));
        console.log(`SLAB: mirrored ${join(clientDir, EXTENSION)}`);
    } catch {
        console.log(`SLAB: no client extension dir at ${clientDir} — run \`spicetify apply\` once`);
    }
}

const match = config.match(/^extensions\s*=\s*(.*)$/m);
const current = (match?.[1] ?? "")
    .split("|")
    .map((name) => name.trim())
    .filter(Boolean);

if (!current.includes(EXTENSION)) {
    current.push(EXTENSION);
    config = config.replace(/^extensions\s*=.*$/m, `extensions            = ${current.join("|")}`);
    await writeFile(configPath, config);
}

console.log(`SLAB: installed ${join(extensionsDir, EXTENSION)}`);
console.log(`SLAB: extensions = ${current.join("|")}`);
console.log("SLAB: reload the client (or run `spicetify apply`) to load it.");
