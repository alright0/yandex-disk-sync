import { Notice, Plugin, TAbstractFile, debounce } from "obsidian";
import { DEFAULT_SETTINGS, YandexSyncSettingTab, YandexSyncSettings } from "./settings";
import { YandexWebDavClient } from "./webdav";
import { SyncEngine, SyncIndex } from "./sync-engine";
import { ExplorerStatusView } from "./explorer-status";

interface PluginData {
	settings: YandexSyncSettings;
	index: SyncIndex;
}

export default class YandexDiskSyncPlugin extends Plugin {
	settings: YandexSyncSettings = DEFAULT_SETTINGS;
	private index: SyncIndex = {};
	private intervalId: number | null = null;
	private syncing = false;
	private statusBarEl: HTMLElement | null = null;
	private debouncedSync = debounce(() => this.syncNow(), 8000, true);
	private explorerStatus: ExplorerStatusView | null = null;

	async onload(): Promise<void> {
		await this.loadPluginData();

		this.addSettingTab(new YandexSyncSettingTab(this.app, this));

		this.statusBarEl = this.addStatusBarItem();
		this.setStatus("idle");

		this.addRibbonIcon("refresh-cw", "Sync with Yandex Disk", () => this.syncNow());

		this.addCommand({
			id: "yandex-disk-sync-now",
			name: "Sync now",
			callback: () => this.syncNow(),
		});

		this.explorerStatus = new ExplorerStatusView(this);
		if (this.settings.showExplorerStatus) this.explorerStatus.start();

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				this.explorerStatus?.recompute(file.path).then(() => this.explorerStatus?.applyToVisible());
				this.onVaultChanged();
			})
		);
		this.registerEvent(
			this.app.vault.on("create", (file) => {
				this.explorerStatus?.recompute(file.path).then(() => this.explorerStatus?.applyToVisible());
				this.onVaultChanged();
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (file: TAbstractFile) => {
				this.explorerStatus?.remove(file.path);
				this.explorerStatus?.applyToVisible();
				this.onVaultChanged();
			})
		);
		this.registerEvent(
			this.app.vault.on("rename", (_file, oldPath) => {
				this.explorerStatus?.remove(oldPath);
				this.explorerStatus?.refreshAll();
				this.onVaultChanged();
			})
		);

		this.restartAutoSyncTimer();

		if (this.settings.syncOnStartup) {
			this.app.workspace.onLayoutReady(() => this.syncNow());
		}
	}

	onunload(): void {
		if (this.intervalId !== null) window.clearInterval(this.intervalId);
		this.explorerStatus?.stop();
	}

	private onVaultChanged(): void {
		if (this.settings.syncOnFileChange) this.debouncedSync();
	}

	getIndex(): Readonly<SyncIndex> {
		return this.index;
	}

	setExplorerStatusEnabled(enabled: boolean): void {
		if (enabled) {
			this.explorerStatus?.start();
		} else {
			this.explorerStatus?.stop();
		}
	}

	restartAutoSyncTimer(): void {
		if (this.intervalId !== null) {
			window.clearInterval(this.intervalId);
			this.intervalId = null;
		}
		if (this.settings.syncIntervalMinutes > 0) {
			this.intervalId = window.setInterval(() => this.syncNow(), this.settings.syncIntervalMinutes * 60 * 1000);
		}
	}

	async syncNow(): Promise<void> {
		if (this.syncing) return;
		if (!this.settings.login || !this.settings.appPassword) {
			new Notice("Yandex Disk Sync: set your login and app password in settings first.");
			return;
		}

		this.syncing = true;
		this.setStatus("syncing…");
		try {
			const client = new YandexWebDavClient(this.settings.login, this.settings.appPassword, this.settings.remoteFolder);
			const engine = new SyncEngine(this.app, client);
			const { index, result } = await engine.sync(this.index, { syncDeletions: this.settings.syncDeletions });
			this.index = index;
			await this.savePluginData();
			await this.explorerStatus?.refreshAll();

			const parts: string[] = [];
			if (result.uploaded) parts.push(`↑${result.uploaded}`);
			if (result.downloaded) parts.push(`↓${result.downloaded}`);
			if (result.deletedRemote || result.deletedLocal) parts.push(`del ${result.deletedRemote + result.deletedLocal}`);
			if (result.conflicts) parts.push(`conflicts ${result.conflicts}`);
			this.setStatus(parts.length ? `synced (${parts.join(", ")})` : "synced");
		} catch (err) {
			console.error("Yandex Disk Sync: sync failed", err);
			new Notice(`Yandex Disk Sync failed: ${(err as Error).message}`);
			this.setStatus("error");
		} finally {
			this.syncing = false;
		}
	}

	private setStatus(text: string): void {
		this.statusBarEl?.setText(`Yandex Disk: ${text}`);
	}

	private async loadPluginData(): Promise<void> {
		const data = (await this.loadData()) as Partial<PluginData> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...(data?.settings ?? {}) };
		this.index = data?.index ?? {};
	}

	async saveSettings(): Promise<void> {
		await this.savePluginData();
	}

	private async savePluginData(): Promise<void> {
		const data: PluginData = { settings: this.settings, index: this.index };
		await this.saveData(data);
	}
}
