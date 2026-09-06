import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type YandexDiskSyncPlugin from "./main";
import { YandexWebDavClient } from "./webdav";

export interface YandexSyncSettings {
	login: string;
	appPassword: string;
	remoteFolder: string;
	syncIntervalMinutes: number;
	syncOnFileChange: boolean;
	syncOnStartup: boolean;
	syncDeletions: boolean;
	showExplorerStatus: boolean;
}

export const DEFAULT_SETTINGS: YandexSyncSettings = {
	login: "",
	appPassword: "",
	remoteFolder: "/ObsidianVault",
	syncIntervalMinutes: 5,
	syncOnFileChange: true,
	syncOnStartup: true,
	syncDeletions: true,
	showExplorerStatus: true,
};

export class YandexSyncSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: YandexDiskSyncPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Yandex Disk Sync" });
		containerEl.createEl("p", {
			text:
				'Uses a WebDAV app password, not your main Yandex password. Create one at id.yandex.ru → ' +
				'Security → App passwords → "Yandex Disk (WebDAV)".',
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Yandex login")
			.setDesc("Your Yandex account login, e.g. name@yandex.ru")
			.addText((text) =>
				text
					.setPlaceholder("name@yandex.ru")
					.setValue(this.plugin.settings.login)
					.onChange(async (value) => {
						this.plugin.settings.login = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("App password")
			.setDesc("WebDAV app password generated at id.yandex.ru — not your account password.")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("app password")
					.setValue(this.plugin.settings.appPassword)
					.onChange(async (value) => {
						this.plugin.settings.appPassword = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Remote folder")
			.setDesc("Folder on Yandex Disk to sync this vault into. Created automatically if missing.")
			.addText((text) =>
				text
					.setPlaceholder("/ObsidianVault")
					.setValue(this.plugin.settings.remoteFolder)
					.onChange(async (value) => {
						this.plugin.settings.remoteFolder = value.trim() || "/ObsidianVault";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Auto-sync interval (minutes)")
			.setDesc("Minutes between automatic syncs. 0 disables the timer — manual sync still works.")
			.addText((text) =>
				text
					.setPlaceholder("5")
					.setValue(String(this.plugin.settings.syncIntervalMinutes))
					.onChange(async (value) => {
						const n = Number(value);
						this.plugin.settings.syncIntervalMinutes = Number.isFinite(n) && n >= 0 ? n : 0;
						await this.plugin.saveSettings();
						this.plugin.restartAutoSyncTimer();
					})
			);

		new Setting(containerEl)
			.setName("Sync on file change")
			.setDesc("Sync a few seconds after you edit, create, delete, or rename a file.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.syncOnFileChange).onChange(async (value) => {
					this.plugin.settings.syncOnFileChange = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Sync on startup")
			.setDesc("Run a sync automatically when Obsidian loads this vault.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.syncOnStartup).onChange(async (value) => {
					this.plugin.settings.syncOnStartup = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Sync deletions")
			.setDesc(
				"When off, deleting a file on one side never deletes it on the other — safer, but deleted files pile up remotely."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.syncDeletions).onChange(async (value) => {
					this.plugin.settings.syncDeletions = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Show sync status in file explorer")
			.setDesc(
				"Small dot next to each file: green = synced, orange = changed since last sync, grey = never synced. " +
					"Uses Obsidian's internal file-explorer DOM, not a public API — turn off if it ever looks broken after an Obsidian update."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showExplorerStatus).onChange(async (value) => {
					this.plugin.settings.showExplorerStatus = value;
					await this.plugin.saveSettings();
					this.plugin.setExplorerStatusEnabled(value);
				})
			);

		new Setting(containerEl)
			.setName("Test connection")
			.setDesc("Checks that the login, app password, and remote folder work.")
			.addButton((btn) =>
				btn.setButtonText("Test").onClick(async () => {
					btn.setDisabled(true);
					try {
						const client = new YandexWebDavClient(
							this.plugin.settings.login,
							this.plugin.settings.appPassword,
							this.plugin.settings.remoteFolder
						);
						await client.testConnection();
						await client.ensureRootFolder();
						new Notice("Yandex Disk Sync: connection OK.");
					} catch (err) {
						console.error(err);
						new Notice(`Yandex Disk Sync: connection failed — ${(err as Error).message}`);
					} finally {
						btn.setDisabled(false);
					}
				})
			);

		new Setting(containerEl)
			.setName("Sync now")
			.setDesc("Run a sync immediately.")
			.addButton((btn) =>
				btn
					.setCta()
					.setButtonText("Sync now")
					.onClick(async () => {
						btn.setDisabled(true);
						await this.plugin.syncNow();
						btn.setDisabled(false);
					})
			);
	}
}
