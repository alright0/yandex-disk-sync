import esbuild from "esbuild";
import process from "process";
import fs from "node:fs";
import path from "node:path";

// Build output lands next to manifest.json / styles.css in the project root, the way a
// standard Obsidian plugin is laid out. Point OBSIDIAN_PLUGIN_DIR at a vault's
// `.obsidian/plugins/yandex-disk-sync/` to have the build write straight there instead;
// manifest.json and styles.css are copied along with main.js in that case.
const PROJECT_DIR = path.resolve(".");
const OUT_DIR = process.env.OBSIDIAN_PLUGIN_DIR
	? path.resolve(process.env.OBSIDIAN_PLUGIN_DIR)
	: PROJECT_DIR;

const banner = `/* Yandex Disk Sync — built ${new Date().toISOString()} */`;
const prod = process.argv[2] === "production";

fs.mkdirSync(OUT_DIR, { recursive: true });

function copyStaticFiles() {
	if (OUT_DIR === PROJECT_DIR) return;
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
