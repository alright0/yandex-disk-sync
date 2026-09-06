import esbuild from "esbuild";
import process from "process";
import fs from "node:fs";
import path from "node:path";

// This source project is intentionally kept outside the Obsidian vault. Every build
// writes/copies its output straight into the vault's plugin folder — nothing in that
// folder is meant to be hand-edited, it's all generated from here.
const OUT_DIR = path.resolve("../pbase/.obsidian/plugins/yandex-disk-sync");

const banner = `/* Yandex Disk Sync — built ${new Date().toISOString()} */`;
const prod = process.argv[2] === "production";

fs.mkdirSync(OUT_DIR, { recursive: true });

function copyStaticFiles() {
	for (const name of ["manifest.json", "styles.css"]) {
		fs.copyFileSync(path.resolve(name), path.join(OUT_DIR, name));
	}
}

const context = await esbuild.context({
	banner: { js: banner },
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: ["obsidian", "electron"],
	format: "cjs",
	target: "es2020",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	outfile: path.join(OUT_DIR, "main.js"),
	minify: prod,
});

copyStaticFiles();

if (prod) {
	await context.rebuild();
	copyStaticFiles();
	process.exit(0);
} else {
	await context.watch();
	console.log(`Watching. Output -> ${OUT_DIR}`);
}
