import type YandexDiskSyncPlugin from "./main";
import { sha1Hex } from "./hash";

type FileStatus = "synced" | "pending" | "unsynced";

/**
 * Draws a small colored dot next to each file in the file explorer, showing
 * whether it matches what was last synced to Yandex Disk. This relies on
 * Obsidian's internal file-explorer DOM structure (.nav-file-title[data-path]),
 * not a public API — it's the same technique plugins like Obsidian Git use for
 * their change-indicator dots, but it can break if Obsidian restructures the
 * explorer in a future release.
 */
export class ExplorerStatusView {
	private observer: MutationObserver | null = null;
	private statuses = new Map<string, FileStatus>();

	constructor(private plugin: YandexDiskSyncPlugin) {}

	start(): void {
		this.plugin.app.workspace.onLayoutReady(() => {
			this.refreshAll();
			this.observeExplorer();
		});
	}

	stop(): void {
		this.observer?.disconnect();
		this.observer = null;
		this.clearAllDots();
	}

	private getExplorerContainer(): HTMLElement | null {
		const leaf = this.plugin.app.workspace.getLeavesOfType("file-explorer")[0];
		return (leaf?.view as { containerEl?: HTMLElement } | undefined)?.containerEl ?? null;
	}

	private observeExplorer(): void {
		const container = this.getExplorerContainer();
		if (!container) return;
		this.observer?.disconnect();
		this.observer = new MutationObserver(() => this.applyToVisible());
		this.observer.observe(container, { childList: true, subtree: true });
		this.applyToVisible();
	}

	async refreshAll(): Promise<void> {
		const files = this.plugin.app.vault.getFiles();
		for (const file of files) {
			await this.recompute(file.path);
		}
		this.applyToVisible();
	}

	async recompute(path: string): Promise<void> {
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!file) {
			this.statuses.delete(path);
			return;
		}
		try {
			const data = await this.plugin.app.vault.adapter.readBinary(path);
			const hash = await sha1Hex(data);
			const entry = this.plugin.getIndex()[path];
			this.statuses.set(path, !entry ? "unsynced" : entry.hash === hash ? "synced" : "pending");
		} catch {
			this.statuses.delete(path);
		}
	}

	remove(path: string): void {
		this.statuses.delete(path);
	}

	applyToVisible(): void {
		if (!this.plugin.settings.showExplorerStatus) return;
		const container = this.getExplorerContainer();
		if (!container) return;
		const titles = container.querySelectorAll<HTMLElement>(".nav-file-title[data-path]");
		titles.forEach((titleEl) => {
			const path = titleEl.dataset.path;
			if (!path) return;
			const status = this.statuses.get(path);
			let dot = titleEl.querySelector<HTMLElement>(":scope > .yds-dot");
			if (!status) {
				dot?.remove();
				return;
			}
			if (!dot) dot = titleEl.createSpan({ cls: "yds-dot" });
			dot.dataset.status = status;
		});
	}

	private clearAllDots(): void {
		const container = this.getExplorerContainer();
		container?.querySelectorAll(".yds-dot").forEach((el) => el.remove());
	}
}
