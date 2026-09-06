import { App, Notice } from "obsidian";
import { YandexWebDavClient, RemoteEntry } from "./webdav";
import { sha1Hex } from "./hash";
import { ancestorDirs, conflictCopyPath } from "./path-utils";

export interface FileState {
	hash: string; // local content hash at last successful sync
	remoteSignature: string; // remote signature at last successful sync
}

export type SyncIndex = Record<string, FileState>;

interface LocalSnapshotEntry {
	path: string;
	hash: string;
}

type Action =
	| { kind: "upload"; path: string }
	| { kind: "download"; path: string }
	| { kind: "deleteRemote"; path: string }
	| { kind: "deleteLocal"; path: string }
	| { kind: "conflict"; path: string };

export interface SyncOptions {
	syncDeletions: boolean;
}

export interface SyncResult {
	uploaded: number;
	downloaded: number;
	deletedRemote: number;
	deletedLocal: number;
	conflicts: number;
}

export class SyncEngine {
	constructor(private app: App, private client: YandexWebDavClient) {}

	async sync(index: SyncIndex, options: SyncOptions): Promise<{ index: SyncIndex; result: SyncResult }> {
		const nextIndex: SyncIndex = { ...index };
		const result: SyncResult = { uploaded: 0, downloaded: 0, deletedRemote: 0, deletedLocal: 0, conflicts: 0 };

		const [localSnapshot, remoteEntries] = await Promise.all([
			this.snapshotLocal(),
			this.client.listRecursive(),
		]);

		const localMap = new Map(localSnapshot.map((f) => [f.path, f]));
		const remoteMap = new Map(remoteEntries.map((f) => [f.path, f]));
		const allPaths = new Set<string>([...localMap.keys(), ...remoteMap.keys(), ...Object.keys(index)]);

		const actions: Action[] = [];

		for (const path of allPaths) {
			const local = localMap.get(path);
			const remote = remoteMap.get(path);
			const synced = index[path];

			if (!synced) {
				if (local && !remote) actions.push({ kind: "upload", path });
				else if (!local && remote) actions.push({ kind: "download", path });
				else if (local && remote) actions.push({ kind: "conflict", path });
				continue;
			}

			const localChanged = !!local && local.hash !== synced.hash;
			const remoteChanged = !!remote && remote.signature !== synced.remoteSignature;
			const localGone = !local;
			const remoteGone = !remote;

			if (localGone && remoteGone) {
				delete nextIndex[path];
				continue;
			}
			if (localGone && !remoteChanged) {
				if (options.syncDeletions) actions.push({ kind: "deleteRemote", path });
				continue;
			}
			if (remoteGone && !localChanged) {
				if (options.syncDeletions) actions.push({ kind: "deleteLocal", path });
				continue;
			}
			if (localGone && remoteChanged) {
				actions.push({ kind: "download", path }); // remote changed after local deletion — keep it
				continue;
			}
			if (remoteGone && localChanged) {
				actions.push({ kind: "upload", path }); // local changed after remote deletion — keep it
				continue;
			}
			if (localChanged && remoteChanged) {
				actions.push({ kind: "conflict", path });
				continue;
			}
			if (localChanged) {
				actions.push({ kind: "upload", path });
				continue;
			}
			if (remoteChanged) {
				actions.push({ kind: "download", path });
				continue;
			}
			// nothing changed on either side
		}

		for (const action of actions) {
			try {
				switch (action.kind) {
					case "upload":
						await this.applyUpload(action.path, nextIndex);
						result.uploaded++;
						break;
					case "download":
						await this.applyDownload(action.path, remoteMap, nextIndex);
						result.downloaded++;
						break;
					case "deleteRemote":
						await this.client.deleteFile(action.path);
						delete nextIndex[action.path];
						result.deletedRemote++;
						break;
					case "deleteLocal":
						await this.deleteLocalFile(action.path);
						delete nextIndex[action.path];
						result.deletedLocal++;
						break;
					case "conflict":
						await this.applyConflict(action.path, nextIndex);
						result.conflicts++;
						break;
				}
			} catch (err) {
				console.error(`Yandex Disk Sync: action "${action.kind}" failed for "${action.path}"`, err);
				new Notice(`Yandex Disk Sync: failed to sync "${action.path}" — see console for details.`);
			}
		}

		return { index: nextIndex, result };
	}

	private async snapshotLocal(): Promise<LocalSnapshotEntry[]> {
		const files = this.app.vault.getFiles();
		const out: LocalSnapshotEntry[] = [];
		for (const file of files) {
			const data = await this.app.vault.adapter.readBinary(file.path);
			out.push({ path: file.path, hash: await sha1Hex(data) });
		}
		return out;
	}

	private async applyUpload(path: string, index: SyncIndex): Promise<void> {
		const data = await this.app.vault.adapter.readBinary(path);
		const putResult = await this.client.putFile(path, data);
		const remote = putResult ?? (await this.client.statFile(path));
		const hash = await sha1Hex(data);
		index[path] = { hash, remoteSignature: remote?.signature ?? "" };
	}

	private async applyDownload(path: string, remoteMap: Map<string, RemoteEntry>, index: SyncIndex): Promise<void> {
		const data = await this.client.getFile(path);
		await this.ensureLocalFolder(path);
		await this.app.vault.adapter.writeBinary(path, data);
		const hash = await sha1Hex(data);
		const remote = remoteMap.get(path);
		index[path] = { hash, remoteSignature: remote?.signature ?? "" };
	}

	private async applyConflict(path: string, index: SyncIndex): Promise<void> {
		// Filesystem-safe timestamp: Windows rejects ":" in filenames (and NTFS reads it as an
		// alternate-data-stream separator), so use "HH-mm" instead of ISO's "HH:mm".
		const stamp = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", "-");
		const label = `conflict ${stamp}`;
		try {
			const remoteData = await this.client.getFile(path);
			const copyPath = conflictCopyPath(path, label);
			await this.ensureLocalFolder(copyPath);
			await this.app.vault.adapter.writeBinary(copyPath, remoteData);
		} catch (err) {
			console.warn(`Yandex Disk Sync: could not save remote copy for conflict on "${path}"`, err);
		}
		await this.applyUpload(path, index);
		new Notice(`Yandex Disk Sync: "${path}" changed on both sides — kept local, saved the remote copy alongside it.`);
	}

	private async deleteLocalFile(path: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file) {
			await this.app.vault.trash(file, true);
		} else {
			await this.app.vault.adapter.remove(path).catch(() => {});
		}
	}

	private async ensureLocalFolder(path: string): Promise<void> {
		for (const dir of ancestorDirs(path)) {
			if (!(await this.app.vault.adapter.exists(dir))) {
				await this.app.vault.adapter.mkdir(dir).catch(() => {});
			}
		}
	}
}
