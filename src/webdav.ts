import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";
import { parentOf } from "./path-utils";

export interface RemoteEntry {
	path: string; // posix path relative to the configured remote folder
	isDirectory: boolean;
	size: number;
	lastModified: number; // ms epoch, 0 if unknown
	signature: string; // opaque string that changes when the remote content changes
}

const BASE_URL = "https://webdav.yandex.ru";
const MAX_RETRIES = 5;
const INITIAL_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30000;

export class YandexWebDavError extends Error {
	constructor(message: string, public status: number) {
		super(message);
	}
}

function encodePath(path: string): string {
	return path
		.split("/")
		.filter(Boolean)
		.map(encodeURIComponent)
		.join("/");
}

function cleanRootOf(rootFolder: string): string {
	return rootFolder.replace(/^\/+|\/+$/g, "");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Yandex sends either a number of seconds or an HTTP date in Retry-After. */
function parseRetryAfterMs(value: string | undefined): number | null {
	if (!value) return null;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return seconds * 1000;
	const dateMs = Date.parse(value);
	if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
	return null;
}

export class YandexWebDavClient {
	private cleanRoot: string;
	/** Directories already confirmed to exist on the remote during this client's lifetime (one sync run). */
	private ensuredDirs = new Set<string>();

	constructor(private login: string, private appPassword: string, rootFolder: string) {
		this.cleanRoot = cleanRootOf(rootFolder);
	}

	private authHeader(): string {
		const raw = `${this.login}:${this.appPassword}`;
		const bytes = new TextEncoder().encode(raw);
		let binary = "";
		bytes.forEach((b) => (binary += String.fromCharCode(b)));
		return `Basic ${btoa(binary)}`;
	}

	private urlFor(relPath: string): string {
		const full = [this.cleanRoot, relPath].filter(Boolean).join("/");
		return `${BASE_URL}/${encodePath(full)}`;
	}

	/** Wraps requestUrl with exponential-backoff retry on HTTP 429 (Yandex's WebDAV endpoint rate-limits undocumented). */
	private async request(params: RequestUrlParam): Promise<RequestUrlResponse> {
		let delay = INITIAL_RETRY_DELAY_MS;
		for (let attempt = 0; ; attempt++) {
			const res = await requestUrl({ ...params, throw: false });
			if (res.status !== 429 || attempt >= MAX_RETRIES) return res;
			const retryAfter = parseRetryAfterMs(res.headers?.["retry-after"] ?? res.headers?.["Retry-After"]);
			const waitMs = retryAfter ?? delay;
			console.warn(
				`Yandex Disk Sync: HTTP 429 for ${params.method} ${params.url} — retrying in ${waitMs}ms (attempt ${
					attempt + 1
				}/${MAX_RETRIES})`
			);
			await sleep(waitMs);
			delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS);
		}
	}

	async testConnection(): Promise<void> {
		const res = await this.request({
			url: `${BASE_URL}/`,
			method: "PROPFIND",
			headers: { Authorization: this.authHeader(), Depth: "0" },
		});
		if (res.status !== 207) {
			throw new YandexWebDavError(`Connection test failed: HTTP ${res.status}`, res.status);
		}
	}

	async ensureRootFolder(): Promise<void> {
		if (!this.cleanRoot) return;
		await this.mkdirChain(this.cleanRoot);
	}

	/** Creates relPath (relative to the sync root) and every ancestor folder below the sync root. */
	async mkdir(relPath: string): Promise<void> {
		if (!relPath) return;
		const full = [this.cleanRoot, relPath].filter(Boolean).join("/");
		await this.mkdirChain(full);
	}

	private async mkdirChain(fullPathFromWebRoot: string): Promise<void> {
		const segments = fullPathFromWebRoot.split("/").filter(Boolean);
		let acc = "";
		for (const seg of segments) {
			acc = acc ? `${acc}/${seg}` : seg;
			if (this.ensuredDirs.has(acc)) continue;
			const res = await this.request({
				url: `${BASE_URL}/${encodePath(acc)}`,
				method: "MKCOL",
				headers: { Authorization: this.authHeader() },
			});
			// 201 created; 405/409 means it already exists — both are fine.
			if (res.status !== 201 && res.status !== 405 && res.status !== 409) {
				throw new YandexWebDavError(`MKCOL failed for "${acc}": HTTP ${res.status}`, res.status);
			}
			this.ensuredDirs.add(acc);
		}
	}

	async listRecursive(): Promise<RemoteEntry[]> {
		await this.ensureRootFolder();
		const out: RemoteEntry[] = [];
		await this.listDir("", out);
		return out;
	}

	private async listDir(relDir: string, out: RemoteEntry[]): Promise<void> {
		const children = await this.propfindChildren(relDir);
		for (const child of children) {
			if (child.isDirectory) {
				this.ensuredDirs.add([this.cleanRoot, child.path].filter(Boolean).join("/"));
				await this.listDir(child.path, out);
			} else {
				out.push(child);
			}
		}
	}

	private async propfindChildren(relDir: string): Promise<RemoteEntry[]> {
		const full = [this.cleanRoot, relDir].filter(Boolean).join("/");
		const body =
			'<?xml version="1.0" encoding="utf-8"?>' +
			'<D:propfind xmlns:D="DAV:"><D:prop>' +
			"<D:resourcetype/><D:getlastmodified/><D:getcontentlength/><D:getetag/>" +
			"</D:prop></D:propfind>";

		const res = await this.request({
			url: `${BASE_URL}/${encodePath(full)}`,
			method: "PROPFIND",
			headers: {
				Authorization: this.authHeader(),
				Depth: "1",
				"Content-Type": "application/xml; charset=utf-8",
			},
			body,
		});

		if (res.status === 404) return [];
		if (res.status !== 207) {
			throw new YandexWebDavError(`PROPFIND failed for "${relDir || "/"}": HTTP ${res.status}`, res.status);
		}

		const xml = new DOMParser().parseFromString(res.text, "application/xml");
		const responses = Array.from(xml.getElementsByTagNameNS("DAV:", "response"));
		const selfPath = relDir.replace(/\/+$/, "");

		const entries: RemoteEntry[] = [];
		for (const respEl of responses) {
			const hrefEl = respEl.getElementsByTagNameNS("DAV:", "href")[0];
			if (!hrefEl?.textContent) continue;

			const hrefPath = decodeURIComponent(hrefEl.textContent).replace(/\/+$/, "");
			const relToRoot = this.stripToRoot(hrefPath);
			if (relToRoot === selfPath) continue; // the queried folder itself

			const isDirectory = respEl.getElementsByTagNameNS("DAV:", "collection").length > 0;
			const lastModEl = respEl.getElementsByTagNameNS("DAV:", "getlastmodified")[0];
			const lenEl = respEl.getElementsByTagNameNS("DAV:", "getcontentlength")[0];
			const etagEl = respEl.getElementsByTagNameNS("DAV:", "getetag")[0];

			entries.push(this.toRemoteEntry(relToRoot, isDirectory, lenEl?.textContent, lastModEl?.textContent, etagEl?.textContent));
		}
		return entries;
	}

	private toRemoteEntry(
		relPath: string,
		isDirectory: boolean,
		lengthText: string | null | undefined,
		lastModifiedText: string | null | undefined,
		etagText: string | null | undefined
	): RemoteEntry {
		const lastModified = lastModifiedText ? Date.parse(lastModifiedText) || 0 : 0;
		const size = lengthText ? parseInt(lengthText, 10) || 0 : 0;
		const etag = etagText ?? "";
		return { path: relPath, isDirectory, size, lastModified, signature: `${size}:${lastModified}:${etag}` };
	}

	/** Strips scheme/host and everything up to and including the configured root folder. */
	private stripToRoot(hrefPath: string): string {
		if (this.cleanRoot) {
			const marker = `/${this.cleanRoot}/`;
			const idx = hrefPath.indexOf(marker);
			if (idx !== -1) return hrefPath.slice(idx + marker.length);
			if (hrefPath === `/${this.cleanRoot}`) return "";
		}
		return hrefPath.replace(/^\/+/, "");
	}

	async getFile(relPath: string): Promise<ArrayBuffer> {
		const res = await this.request({
			url: this.urlFor(relPath),
			method: "GET",
			headers: { Authorization: this.authHeader() },
		});
		if (res.status !== 200) {
			throw new YandexWebDavError(`GET failed for "${relPath}": HTTP ${res.status}`, res.status);
		}
		return res.arrayBuffer;
	}

	/**
	 * Uploads a file and returns the resulting RemoteEntry when the server's response headers are
	 * enough to build one (avoids a follow-up PROPFIND just to learn the new signature). Returns
	 * null when the headers are insufficient — callers should fall back to statFile() in that case.
	 */
	async putFile(relPath: string, data: ArrayBuffer): Promise<RemoteEntry | null> {
		await this.mkdir(parentOf(relPath));
		const res = await this.request({
			url: this.urlFor(relPath),
			method: "PUT",
			headers: {
				Authorization: this.authHeader(),
				"Content-Type": "application/octet-stream",
			},
			body: data,
		});
		if (res.status !== 201 && res.status !== 204) {
			throw new YandexWebDavError(`PUT failed for "${relPath}": HTTP ${res.status}`, res.status);
		}
		const etag = res.headers?.["etag"] ?? res.headers?.["ETag"];
		const lastModified = res.headers?.["last-modified"] ?? res.headers?.["Last-Modified"];
		if (!etag && !lastModified) return null;
		return this.toRemoteEntry(relPath, false, String(data.byteLength), lastModified, etag);
	}

	async deleteFile(relPath: string): Promise<void> {
		const res = await this.request({
			url: this.urlFor(relPath),
			method: "DELETE",
			headers: { Authorization: this.authHeader() },
		});
		if (res.status !== 204 && res.status !== 200 && res.status !== 404) {
			throw new YandexWebDavError(`DELETE failed for "${relPath}": HTTP ${res.status}`, res.status);
		}
	}

	async statFile(relPath: string): Promise<RemoteEntry | null> {
		const siblings = await this.propfindChildren(parentOf(relPath));
		return siblings.find((e) => e.path === relPath) ?? null;
	}
}
