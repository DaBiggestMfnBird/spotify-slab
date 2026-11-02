#!/usr/bin/env node
/**
 * Install SLAB into Spicetify's extension folder and register it in the config.
 * Does not restart Spotify — run `spicetify apply` when you're ready.
 */

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
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
console.log("SLAB: run `spicetify apply` to load it into Spotify.");
