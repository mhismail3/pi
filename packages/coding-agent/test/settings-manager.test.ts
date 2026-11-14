import { syncBuiltinESMExports } from "node:module";
import { createHash } from "crypto";
import fs, {
	chmodSync,
	existsSync,
	linkSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "fs";
import { homedir } from "os";
import { join } from "path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HTTP_IDLE_TIMEOUT_MS } from "../src/core/http-dispatcher.ts";
import { type Settings, SettingsManager } from "../src/core/settings-manager.ts";

describe("SettingsManager", () => {
	const testDir = join(process.cwd(), "test-settings-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");

	beforeEach(() => {
		// Clean up and create fresh directories
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		syncBuiltinESMExports();
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	describe("preserves externally added settings", () => {
		it("should preserve enabledModels when changing thinking level", async () => {
			// Create initial settings file
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "dark",
					defaultModel: "claude-sonnet",
				}),
			);

			// Create SettingsManager (simulates pi starting up)
			const manager = SettingsManager.create(projectDir, agentDir);

			// Simulate user editing settings.json externally to add enabledModels
			const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			currentSettings.enabledModels = ["claude-opus-4-5", "gpt-5.2-codex"];
			writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

			// User changes thinking level via Shift+Tab
			manager.setDefaultThinkingLevel("high");
			await manager.flush();

			// Verify enabledModels is preserved
			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.enabledModels).toEqual(["claude-opus-4-5", "gpt-5.2-codex"]);
			expect(savedSettings.defaultThinkingLevel).toBe("high");
			expect(savedSettings.theme).toBe("dark");
			expect(savedSettings.defaultModel).toBe("claude-sonnet");
		});

		it("should preserve custom settings when changing theme", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					defaultModel: "claude-sonnet",
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			// User adds custom settings externally
			const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			currentSettings.shellPath = "/bin/zsh";
			currentSettings.extensions = ["/path/to/extension.ts"];
			writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

			// User changes theme
			manager.setTheme("light");
			await manager.flush();

			// Verify all settings preserved
			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.shellPath).toBe("/bin/zsh");
			expect(savedSettings.extensions).toEqual(["/path/to/extension.ts"]);
			expect(savedSettings.theme).toBe("light");
		});

		it("should let in-memory changes override file changes for same key", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "dark",
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			// User externally sets thinking level to "low"
			const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			currentSettings.defaultThinkingLevel = "low";
			writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

			// But then changes it via UI to "high"
			manager.setDefaultThinkingLevel("high");
			await manager.flush();

			// In-memory change should win
			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.defaultThinkingLevel).toBe("high");
		});
	});

	describe("backup-first global unset", () => {
		it("backs up exact bytes and serializes deletion between setters without resurrecting keys", async () => {
			const settingsPath = join(agentDir, "settings.json");
			const original = Buffer.from('\uFEFF{ "theme": "dark", "hideThinkingBlock": true, "custom": {"keep": 1} }\n');
			writeFileSync(settingsPath, original);
			const manager = SettingsManager.create(projectDir, agentDir);
			const unset = manager.unsetGlobalSettings(["theme", "hideThinkingBlock", "theme"]);
			manager.setDefaultThinkingLevel("high");
			const receipt = await unset;
			await manager.flush();
			expect(receipt.status).toBe("applied");
			if (receipt.status !== "applied") throw new Error("Expected applied receipt");
			expect(readFileSync(receipt.backupPath)).toEqual(original);
			expect(statSync(receipt.backupPath).mode & 0o777).toBe(0o600);
			expect(receipt.beforeSha256).toBe(createHash("sha256").update(original).digest("hex"));
			expect(receipt.afterSha256).toBe(
				createHash("sha256")
					.update(`${JSON.stringify({ custom: { keep: 1 } }, null, 2)}\n`)
					.digest("hex"),
			);
			expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
			expect(receipt.changedKeys).toEqual(["theme", "hideThinkingBlock"]);
			expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
				custom: { keep: 1 },
				defaultThinkingLevel: "high",
			});
			expect(manager.getTheme()).toBeUndefined();
			expect(manager.getHideThinkingBlock()).toBe(false);
			expect(SettingsManager.create(projectDir, agentDir).getGlobalSettings()).toEqual(manager.getGlobalSettings());
			expect(await manager.unsetGlobalSettings(["theme"])).toEqual({ status: "unchanged", changedKeys: [] });
			expect(await manager.unsetGlobalSettings([])).toEqual({ status: "unchanged", changedKeys: [] });
			expect(manager.drainErrors()).toEqual([]);
			expect(readdirSync(agentDir).filter((name) => name.includes(".backup-"))).toHaveLength(1);
		});

		it("preserves prior queued writes, external fields, later same-key setters and project overrides", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark", hideThinkingBlock: true }));
			writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ theme: "project" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark", hideThinkingBlock: true, external: 7 }));
			manager.setDefaultThinkingLevel("low");
			const unset = manager.unsetGlobalSettings(["theme", "hideThinkingBlock"]);
			manager.setTheme("dark");
			const receipt = await unset;
			await manager.flush();
			expect(receipt.status).toBe("applied");
			expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
				theme: "dark",
				defaultThinkingLevel: "low",
				external: 7,
			});
			expect(manager.getGlobalSettings().theme).toBe("dark");
			expect(manager.getTheme()).toBe("project");
		});

		it("retains failed setter ownership after storage repair unless unset explicitly deletes it", async () => {
			const settingsPath = join(agentDir, "settings.json");
			for (const unset of [false, true]) {
				writeFileSync(settingsPath, '{"theme":"old"}');
				const manager = SettingsManager.create(projectDir, agentDir);
				writeFileSync(settingsPath, "{");
				manager.setTheme("new");
				await manager.flush();
				expect(manager.drainErrors()).toHaveLength(1);
				writeFileSync(settingsPath, '{"theme":"old"}');
				if (unset) await manager.unsetGlobalSettings(["theme"]);
				manager.setDefaultThinkingLevel("high");
				await manager.flush();
				const expected = unset ? { defaultThinkingLevel: "high" } : { theme: "new", defaultThinkingLevel: "high" };
				expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual(expected);
				expect(manager.getGlobalSettings()).toEqual(expected);
				expect(SettingsManager.create(projectDir, agentDir).getGlobalSettings()).toEqual(expected);
				expect(manager.drainErrors()).toEqual([]);
			}
		});

		it("rebases later nested and map-entry edits onto deletion in memory and on disk", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					compaction: { enabled: true, reserveTokens: 321 },
					terminal: { showImages: true, trueColor: false },
					images: { autoResize: true, blockImages: true },
					retry: { enabled: true, maxRetries: 9 },
					markdown: { mermaid: "off", codeBlockIndent: "old" },
					modelThinkingLevels: { "old/model": "low", "stale/model": "medium" },
					extensionChangelogVersions: { old: "1" },
				}),
			);
			const manager = SettingsManager.create(projectDir, agentDir);
			const unset = manager.unsetGlobalSettings([
				"compaction",
				"terminal",
				"images",
				"retry",
				"markdown",
				"modelThinkingLevels",
				"extensionChangelogVersions",
			]);
			manager.setCompactionEnabled(false);
			manager.setShowImages(false);
			manager.setImageAutoResize(false);
			manager.setRetryEnabled(false);
			manager.setMermaidRenderingMode("final");
			manager.setModelThinkingLevel("new", "model", "high");
			manager.removeModelThinkingLevel("old", "model");
			manager.setExtensionChangelogVersion("new", "2");
			await unset;
			await manager.flush();
			const expected = {
				compaction: { enabled: false },
				terminal: { showImages: false },
				images: { autoResize: false },
				retry: { enabled: false },
				markdown: { mermaid: "final" },
				modelThinkingLevels: { "new/model": "high" },
				extensionChangelogVersions: { new: "2" },
			};
			expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual(expected);
			expect(manager.getGlobalSettings()).toEqual(expected);
			const fresh = SettingsManager.create(projectDir, agentDir);
			expect(fresh.getGlobalSettings()).toEqual(expected);
			expect(manager.getCompactionSettings()).toEqual(fresh.getCompactionSettings());
			expect(manager.getRetrySettings()).toEqual(fresh.getRetrySettings());
			expect(manager.getTerminalCapabilityOverrides()).toEqual(fresh.getTerminalCapabilityOverrides());
			expect(manager.getBlockImages()).toBe(fresh.getBlockImages());
			expect(manager.getCodeBlockIndent()).toBe(fresh.getCodeBlockIndent());
			expect(manager.drainErrors()).toEqual([]);
		});

		it("does not create a backup or canonical file for a missing source", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(await manager.unsetGlobalSettings(["theme", "theme"])).toEqual({
				status: "unchanged",
				changedKeys: [],
			});
			expect(readdirSync(agentDir)).toEqual([]);
		});

		it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
			"reaches backup creation under the real lock before filesystem write denial",
			async () => {
				const settingsPath = join(agentDir, "settings.json");
				const original = '{"theme":"dark","private":"fixture-only"}';
				writeFileSync(settingsPath, original);
				const manager = SettingsManager.create(projectDir, agentDir);
				const realOpen = fs.openSync;
				let reachedBackup = false;
				vi.spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
					if (String(path).includes(".backup-")) {
						expect(existsSync(`${settingsPath}.lock`)).toBe(true);
						reachedBackup = true;
						chmodSync(agentDir, 0o500);
					}
					return realOpen(path, flags, mode);
				});
				syncBuiltinESMExports();
				try {
					await expect(manager.unsetGlobalSettings(["theme"])).rejects.toMatchObject({
						phase: "backup-create",
						replacement: "not-attempted",
						recovery: undefined,
					});
					expect(reachedBackup).toBe(true);
					expect(readFileSync(settingsPath, "utf8")).toBe(original);
					expect(manager.getTheme()).toBe("dark");
					expect(
						readdirSync(agentDir).filter((name) => name.includes(".backup-") || name.includes(".unset-")),
					).toEqual([]);
				} finally {
					chmodSync(agentDir, 0o700);
				}
			},
		);

		it.skipIf(process.platform === "win32")(
			"reports syscall failure phases and recovery without confusing injected errors with physical durability proof",
			async () => {
				const settingsPath = join(agentDir, "settings.json");
				const original = Buffer.from('{"theme":"dark","private":"fixture-only"}\n');
				for (const fault of [
					"backup-sync",
					"backup-directory-sync",
					"temporary-sync",
					"rename",
					"commit-directory-sync",
				] as const) {
					writeFileSync(settingsPath, original);
					const manager = SettingsManager.create(projectDir, agentDir);
					const realOpen = fs.openSync;
					const realSync = fs.fsyncSync;
					const realRename = fs.renameSync;
					const paths = new Map<number, string>();
					let directorySyncs = 0;
					vi.spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
						const fd = realOpen(path, flags, mode);
						paths.set(fd, String(path));
						return fd;
					});
					vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
						const path = paths.get(fd);
						if (path === agentDir) directorySyncs++;
						if (
							(fault === "backup-sync" && path?.includes(".backup-")) ||
							(fault === "backup-directory-sync" && path === agentDir && directorySyncs === 1) ||
							(fault === "temporary-sync" && path?.includes(".unset-")) ||
							(fault === "commit-directory-sync" && path === agentDir && directorySyncs === 2)
						)
							throw new Error("injected fsync failure");
						realSync(fd);
					});
					vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
						if (fault === "rename") throw new Error("injected rename failure");
						realRename(source, target);
					});
					syncBuiltinESMExports();
					try {
						const failure: unknown = await manager
							.unsetGlobalSettings(["theme"])
							.catch((error: unknown) => error);
						const backups = readdirSync(agentDir).filter((name) => name.includes(".backup-"));
						const backupPath = join(agentDir, backups[backups.length - 1]);
						const verified = fault !== "backup-sync" && fault !== "backup-directory-sync";
						expect(failure).toMatchObject({
							phase: fault,
							replacement:
								fault === "rename" || fault === "commit-directory-sync" ? "uncertain" : "not-attempted",
							recovery: verified
								? {
										kind: "verified-backup",
										backupPath,
										beforeSha256: createHash("sha256").update(original).digest("hex"),
									}
								: { kind: "unverified-backup", backupPath },
						});
						expect(readFileSync(backupPath)).toEqual(original);
						expect(statSync(backupPath).mode & 0o777).toBe(0o600);
						expect(readFileSync(settingsPath)).toEqual(
							fault === "commit-directory-sync"
								? Buffer.from(`${JSON.stringify({ private: "fixture-only" }, null, 2)}\n`)
								: original,
						);
						expect(readdirSync(agentDir).filter((name) => name.includes(".unset-"))).toEqual([]);
						if (fault === "commit-directory-sync") {
							manager.setDefaultThinkingLevel("high");
							await manager.flush();
							expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ private: "fixture-only" });
							await manager.reload();
							expect(manager.getGlobalSettings()).toEqual({ private: "fixture-only" });
						}
					} finally {
						vi.restoreAllMocks();
						syncBuiltinESMExports();
						for (const name of readdirSync(agentDir).filter((name) => name.includes(".backup-")))
							rmSync(join(agentDir, name));
					}
				}
			},
		);

		it.skipIf(process.platform === "win32")(
			"preserves primary phase and recovery when descriptor close and lock release also fail",
			async () => {
				const settingsPath = join(agentDir, "settings.json");
				writeFileSync(settingsPath, '{"theme":"dark"}');
				const manager = SettingsManager.create(projectDir, agentDir);
				const realOpen = fs.openSync;
				const realSync = fs.fsyncSync;
				const realClose = fs.closeSync;
				const realLock = lockfile.lockSync;
				let directoryFd: number | undefined;
				let backupFd: number | undefined;
				vi.spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
					const fd = realOpen(path, flags, mode);
					if (String(path) === agentDir) directoryFd = fd;
					if (String(path).includes(".backup-")) backupFd = fd;
					return fd;
				});
				vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
					if (fd === backupFd) throw new Error("primary private-fixture");
					realSync(fd);
				});
				vi.spyOn(fs, "closeSync").mockImplementation((fd) => {
					realClose(fd);
					if (fd === directoryFd) throw new Error("secondary private-fixture");
				});
				vi.spyOn(lockfile, "lockSync").mockImplementation((path, options) => {
					const release = realLock(path, options);
					return () => {
						release();
						throw new Error("release private-fixture");
					};
				});
				syncBuiltinESMExports();
				await expect(manager.unsetGlobalSettings(["theme"])).rejects.toMatchObject({
					message: "Settings unset refused before commit",
					phase: "backup-sync",
					replacement: "not-attempted",
					recovery: { kind: "unverified-backup" },
					cleanupFailures: ["close", "release"],
				});
				expect(readFileSync(settingsPath, "utf8")).toBe('{"theme":"dark"}');
				expect(existsSync(`${settingsPath}.lock`)).toBe(false);
			},
		);

		it.skipIf(process.platform === "win32")(
			"refuses real entry and metadata drift and never removes a foreign temporary pathname",
			async () => {
				const settingsPath = join(agentDir, "settings.json");
				const original = '{"theme":"dark"}';
				for (const fault of [
					"collision",
					"file",
					"mode",
					"directory-before-read",
					"directory-after-temporary",
				] as const) {
					writeFileSync(settingsPath, original);
					chmodSync(settingsPath, 0o644);
					const manager = SettingsManager.create(projectDir, agentDir);
					const realOpen = fs.openSync;
					const realSync = fs.fsyncSync;
					let temporary: string | undefined;
					let temporaryFd: number | undefined;
					let drifted = false;
					const moved = join(testDir, `moved-${fault}`);
					vi.spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
						const name = String(path);
						if (name.includes(".unset-") && flags === "wx") {
							temporary = name;
							if (fault === "collision") writeFileSync(name, "foreign-collision");
						}
						const fd = realOpen(path, flags, mode);
						if (name === temporary) temporaryFd = fd;
						if (
							fault === "directory-before-read" &&
							name === settingsPath &&
							typeof flags === "number" &&
							!drifted
						) {
							drifted = true;
							fs.renameSync(agentDir, moved);
							mkdirSync(agentDir);
							fs.renameSync(join(moved, "settings.json"), settingsPath);
						}
						return fd;
					});
					vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
						realSync(fd);
						if (fd !== temporaryFd || drifted) return;
						drifted = true;
						if (fault === "file") {
							const other = join(agentDir, "writer");
							writeFileSync(other, '{"theme":"intervening"}');
							fs.renameSync(other, settingsPath);
						}
						if (fault === "mode") chmodSync(settingsPath, 0o640);
						if (fault === "directory-after-temporary" && temporary) {
							fs.renameSync(agentDir, moved);
							mkdirSync(agentDir);
							writeFileSync(settingsPath, "intervening-directory");
							writeFileSync(temporary, "foreign-directory");
						}
					});
					syncBuiltinESMExports();
					try {
						await expect(manager.unsetGlobalSettings(["theme"])).rejects.toThrow();
						expect(readFileSync(settingsPath, "utf8")).toBe(
							fault === "file"
								? '{"theme":"intervening"}'
								: fault === "directory-after-temporary"
									? "intervening-directory"
									: original,
						);
						if (fault === "mode") expect(statSync(settingsPath).mode & 0o777).toBe(0o640);
						if (fault === "collision" || fault === "directory-after-temporary")
							expect(readFileSync(temporary!, "utf8")).toBe(
								fault === "collision" ? "foreign-collision" : "foreign-directory",
							);
					} finally {
						vi.restoreAllMocks();
						syncBuiltinESMExports();
						for (const name of readdirSync(agentDir))
							rmSync(join(agentDir, name), { recursive: true, force: true });
					}
				}
			},
		);

		it("refuses unsupported storage, unknown keys, unsafe files and filesystem write denial without mutation", async () => {
			await expect(SettingsManager.inMemory({ theme: "dark" }).unsetGlobalSettings(["theme"])).rejects.toThrow(
				"Unset requires file settings storage",
			);
			const settingsPath = join(agentDir, "settings.json");
			const original = '{"theme":"dark","private":"not-in-receipts"}';
			writeFileSync(settingsPath, original);
			const manager = SettingsManager.create(projectDir, agentDir);
			await expect(manager.unsetGlobalSettings(["unknown" as "theme"])).rejects.toThrow("Unknown settings key");
			linkSync(settingsPath, join(agentDir, "linked"));
			await expect(manager.unsetGlobalSettings(["theme"])).rejects.toThrow("Unsafe settings file");
			rmSync(join(agentDir, "linked"));
			rmSync(settingsPath);
			symlinkSync(join(agentDir, "target"), settingsPath);
			writeFileSync(join(agentDir, "target"), original);
			await expect(manager.unsetGlobalSettings(["theme"])).rejects.toThrow("Unsafe settings file");
			expect(readFileSync(settingsPath, "utf8")).toBe(original);
			rmSync(settingsPath);
			writeFileSync(settingsPath, original);
			chmodSync(settingsPath, 0o666);
			await expect(manager.unsetGlobalSettings(["theme"])).rejects.toThrow("Unsafe settings file");
			expect(readFileSync(settingsPath, "utf8")).toBe(original);
			chmodSync(settingsPath, 0o600);
			const invalidUtf8 = Buffer.concat([Buffer.from('{"theme":"'), Buffer.from([0xff]), Buffer.from('"}')]);
			writeFileSync(settingsPath, invalidUtf8);
			await expect(manager.unsetGlobalSettings(["theme"])).rejects.toThrow("Invalid settings file");
			expect(readFileSync(settingsPath)).toEqual(invalidUtf8);
			writeFileSync(settingsPath, original);
			chmodSync(agentDir, 0o500);
			try {
				await expect(manager.unsetGlobalSettings(["theme"])).rejects.toThrow();
				expect(readFileSync(settingsPath, "utf8")).toBe(original);
				expect(manager.getTheme()).toBe("dark");
			} finally {
				chmodSync(agentDir, 0o700);
			}
		});
	});

	describe("deviceId", () => {
		it("creates one global device ID and reuses it in later processes", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));
			writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ deviceId: "project-device" }));
			const first = SettingsManager.create(projectDir, agentDir);

			const deviceId = first.getOrCreateDeviceId();
			await first.flush();

			expect(deviceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
			expect(first.getOrCreateDeviceId()).toBe(deviceId);
			expect(SettingsManager.create(projectDir, agentDir).getOrCreateDeviceId()).toBe(deviceId);
			expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual({ theme: "dark", deviceId });
		});
	});

	describe("packages migration", () => {
		it("should keep local-only extensions in extensions array", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					extensions: ["/local/ext.ts", "./relative/ext.ts"],
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getPackages()).toEqual([]);
			expect(manager.getExtensionPaths()).toEqual(["/local/ext.ts", "./relative/ext.ts"]);
		});

		it("should handle packages with filtering objects", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					packages: [
						"npm:simple-pkg",
						{
							source: "npm:shitty-extensions",
							extensions: ["extensions/oracle.ts"],
							skills: [],
						},
					],
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			const packages = manager.getPackages();
			expect(packages).toHaveLength(2);
			expect(packages[0]).toBe("npm:simple-pkg");
			expect(packages[1]).toEqual({
				source: "npm:shitty-extensions",
				extensions: ["extensions/oracle.ts"],
				skills: [],
			});
		});
	});

	describe("reload", () => {
		it.each([false, true])(
			"preserves global setters accepted after reload starts (load recovery: %s)",
			async (recovering) => {
				const settingsPath = join(agentDir, "settings.json");
				writeFileSync(settingsPath, JSON.stringify({ theme: "old" }));
				const manager = SettingsManager.create(projectDir, agentDir);
				if (recovering) {
					writeFileSync(settingsPath, "{ invalid json");
					await manager.reload();
					expect(manager.drainErrors()).toMatchObject([{ scope: "global", path: settingsPath }]);
					writeFileSync(settingsPath, JSON.stringify({ theme: "old" }));
				}

				const loading = manager.reload();
				manager.setTheme("new");
				await loading;
				await manager.flush();

				const expected = { theme: "new" };
				expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual(expected);
				expect(manager.getTheme()).toBe("new");
				expect(manager.getGlobalSettings()).toEqual(expected);
				const fresh = SettingsManager.create(projectDir, agentDir);
				expect(fresh.getGlobalSettings()).toEqual(expected);
				expect(fresh.getSettings()).toEqual(manager.getSettings());
				expect(manager.drainErrors()).toEqual([]);
				expect(fresh.drainErrors()).toEqual([]);
			},
		);

		it("should reload global settings from disk", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "dark",
					extensions: ["/before.ts"],
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "light",
					extensions: ["/after.ts"],
					defaultModel: "claude-sonnet",
				}),
			);

			await manager.reload();

			expect(manager.getTheme()).toBe("light");
			expect(manager.getExtensionPaths()).toEqual(["/after.ts"]);
			expect(manager.getDefaultModel()).toBe("claude-sonnet");
		});

		it("should keep previous settings and report the file path when the file is invalid", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			writeFileSync(settingsPath, "{ invalid json");
			await manager.reload();

			expect(manager.getTheme()).toBe("dark");
			expect(manager.drainErrors()).toMatchObject([{ scope: "global", path: settingsPath }]);
		});
	});

	describe("theme setting", () => {
		it("stores slash-separated automatic theme settings separately from fixed theme names", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "light/dark" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getTheme()).toBeUndefined();
			expect(manager.getThemeSetting()).toBe("light/dark");

			manager.setTheme("solarized-light/tokyo-night");
			await manager.flush();

			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.theme).toBe("solarized-light/tokyo-night");
		});
	});

	describe("error tracking", () => {
		it("should collect and clear load errors via drainErrors", () => {
			const globalSettingsPath = join(agentDir, "settings.json");
			const projectSettingsPath = join(projectDir, ".pi", "settings.json");
			writeFileSync(globalSettingsPath, "{ invalid global json");
			writeFileSync(projectSettingsPath, "{ invalid project json");

			const manager = SettingsManager.create(projectDir, agentDir);
			const errors = manager.drainErrors();

			expect(errors).toHaveLength(2);
			expect(errors).toMatchObject([
				{ scope: "global", path: globalSettingsPath },
				{ scope: "project", path: projectSettingsPath },
			]);
			expect(manager.drainErrors()).toEqual([]);
		});
	});

	describe("project trust", () => {
		it("should skip project settings when project is not trusted", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "global" }));
			writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ theme: "project" }));

			const manager = SettingsManager.create(projectDir, agentDir, { projectTrusted: false });

			expect(manager.isProjectTrusted()).toBe(false);
			expect(manager.getTheme()).toBe("global");
			expect(manager.getProjectSettings()).toEqual({});
		});

		it("should reload project settings after trust changes to true", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "global" }));
			writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ theme: "project" }));
			const manager = SettingsManager.create(projectDir, agentDir, { projectTrusted: false });

			manager.setProjectTrusted(true);

			expect(manager.isProjectTrusted()).toBe(true);
			expect(manager.getTheme()).toBe("project");
		});

		it("should fail project settings writes when project is not trusted", async () => {
			const projectSettingsPath = join(projectDir, ".pi", "settings.json");
			writeFileSync(projectSettingsPath, JSON.stringify({ packages: ["npm:existing"] }));
			const manager = SettingsManager.create(projectDir, agentDir, { projectTrusted: false });

			expect(() => manager.setProjectPackages(["npm:new"])).toThrow(
				"Project is not trusted; refusing to write project settings",
			);
			await manager.flush();

			expect(manager.getProjectSettings()).toEqual({});
			expect(JSON.parse(readFileSync(projectSettingsPath, "utf-8"))).toEqual({ packages: ["npm:existing"] });
		});

		it("should read default project trust from global settings only", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
			writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ defaultProjectTrust: "never" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getDefaultProjectTrust()).toBe("always");
		});

		it("should default invalid project trust settings to ask", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "sometimes" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getDefaultProjectTrust()).toBe("ask");
		});
	});

	describe("project settings directory creation", () => {
		it("should not create .pi folder when only reading project settings", () => {
			// Create agent dir with global settings, but NO .pi folder in project
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			// Delete the .pi folder that beforeEach created
			rmSync(join(projectDir, ".pi"), { recursive: true });

			// Create SettingsManager (reads both global and project settings)
			const manager = SettingsManager.create(projectDir, agentDir);

			// .pi folder should NOT have been created just from reading
			expect(existsSync(join(projectDir, ".pi"))).toBe(false);

			// Settings should still be loaded from global
			expect(manager.getTheme()).toBe("dark");
		});

		it("should create .pi folder when writing project settings", async () => {
			// Create agent dir with global settings, but NO .pi folder in project
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			// Delete the .pi folder that beforeEach created
			rmSync(join(projectDir, ".pi"), { recursive: true });

			const manager = SettingsManager.create(projectDir, agentDir);

			// .pi folder should NOT exist yet
			expect(existsSync(join(projectDir, ".pi"))).toBe(false);

			// Write a project-specific setting
			manager.setProjectPackages([{ source: "npm:test-pkg" }]);
			await manager.flush();

			// Now .pi folder should exist
			expect(existsSync(join(projectDir, ".pi"))).toBe(true);

			// And settings file should be created
			expect(existsSync(join(projectDir, ".pi", "settings.json"))).toBe(true);
		});
	});

	describe("terminal capability overrides", () => {
		it("maps explicit values and omits auto values", () => {
			const getOverrides = (terminal: NonNullable<Settings["terminal"]>) =>
				SettingsManager.inMemory({ terminal }).getTerminalCapabilityOverrides();

			expect(getOverrides({ images: false, trueColor: false, hyperlinks: false })).toEqual({
				images: null,
				trueColor: false,
				hyperlinks: false,
			});
			expect(getOverrides({ images: "kitty", trueColor: true, hyperlinks: true })).toEqual({
				images: "kitty",
				trueColor: true,
				hyperlinks: true,
			});
			expect(getOverrides({ images: "auto", trueColor: "auto", hyperlinks: "auto" })).toEqual({});
		});
	});

	describe("retry settings", () => {
		it("defaults and overrides agent retry delay cap", () => {
			expect(SettingsManager.inMemory().getRetrySettings()).toEqual({
				enabled: true,
				maxRetries: 3,
				baseDelayMs: 2000,
				maxAgentDelayMs: 60000,
			});
			expect(
				SettingsManager.inMemory({
					retry: { enabled: true, maxRetries: 10, baseDelayMs: 500, maxAgentDelayMs: 5000 },
				}).getRetrySettings(),
			).toEqual({ enabled: true, maxRetries: 10, baseDelayMs: 500, maxAgentDelayMs: 5000 });
		});
	});

	describe("httpIdleTimeoutMs", () => {
		it("should default to 5 minutes", () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getHttpIdleTimeoutMs()).toBe(DEFAULT_HTTP_IDLE_TIMEOUT_MS);
		});

		it("should use merged global and project settings", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ httpIdleTimeoutMs: 300000 }));
			writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ httpIdleTimeoutMs: 0 }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getHttpIdleTimeoutMs()).toBe(0);
		});

		it("should reject invalid timeout values", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ httpIdleTimeoutMs: -1 }));
			const manager = SettingsManager.create(projectDir, agentDir);

			expect(() => manager.getHttpIdleTimeoutMs()).toThrow("Invalid httpIdleTimeoutMs setting");
		});
	});

	describe("cacheWarming", () => {
		it("defaults to idle and ignores project settings", () => {
			expect(SettingsManager.create(projectDir, agentDir).getCacheWarmingMode()).toBe("idle");

			writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ cacheWarming: "streaming" }));
			expect(SettingsManager.create(projectDir, agentDir).getCacheWarmingMode()).toBe("idle");

			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: "streaming" }));
			expect(SettingsManager.create(projectDir, agentDir).getCacheWarmingMode()).toBe("streaming");

			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: "bogus" }));
			expect(SettingsManager.create(projectDir, agentDir).getCacheWarmingMode()).toBe("idle");
		});

		it("persists the mode globally", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setCacheWarmingMode("off");
			await manager.flush();

			expect(SettingsManager.create(projectDir, agentDir).getCacheWarmingMode()).toBe("off");
			expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toEqual({ cacheWarming: "off" });
		});
	});

	describe("externalEditor", () => {
		const originalVisual = process.env.VISUAL;
		const originalEditor = process.env.EDITOR;
		const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

		function setEditorEnv(visual?: string, editor?: string): void {
			if (visual === undefined) delete process.env.VISUAL;
			else process.env.VISUAL = visual;
			if (editor === undefined) delete process.env.EDITOR;
			else process.env.EDITOR = editor;
		}

		afterEach(() => {
			setEditorEnv(originalVisual, originalEditor);
			if (originalPlatform) {
				Object.defineProperty(process, "platform", originalPlatform);
			}
		});

		it("should resolve editor commands by precedence", () => {
			setEditorEnv("vim", "nano");
			expect(SettingsManager.inMemory({ externalEditor: "code --wait" }).getExternalEditorCommand()).toBe(
				"code --wait",
			);
			expect(SettingsManager.inMemory().getExternalEditorCommand()).toBe("vim");

			setEditorEnv(undefined, "emacs");
			expect(SettingsManager.inMemory().getExternalEditorCommand()).toBe("emacs");
		});

		it("should fall back to platform defaults", () => {
			setEditorEnv();
			Object.defineProperty(process, "platform", { value: "win32" });
			expect(SettingsManager.inMemory().getExternalEditorCommand()).toBe("notepad");

			Object.defineProperty(process, "platform", { value: "darwin" });
			expect(SettingsManager.inMemory().getExternalEditorCommand()).toBe("nano");

			Object.defineProperty(process, "platform", { value: "linux" });
			expect(SettingsManager.inMemory().getExternalEditorCommand()).toBe("nano");
		});
	});

	describe("TUI mode", () => {
		it("defaults to fullscreen and persists regular mode", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getTuiMode()).toBe("fullscreen");

			manager.setTuiMode("regular");
			await manager.flush();

			expect(manager.getTuiMode()).toBe("regular");
			const savedSettings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
			expect(savedSettings.tuiMode).toBe("regular");
		});

		it("falls back to fullscreen for unsupported values", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ tuiMode: "other" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getTuiMode()).toBe("fullscreen");
		});

		it("does not recognize the old uiMode setting", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ uiMode: "regular" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getTuiMode()).toBe("fullscreen");
		});
	});

	it("validates and persists fullscreen settings", async () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getFullscreenExitOutput()).toBe("transcript");
		expect(manager.getFullscreenScrollbar()).toBe("auto");
		expect(manager.getFullscreenCopyOnSelect()).toBe(true);

		manager.setFullscreenExitOutput("resume-hint");
		manager.setFullscreenScrollbar("hidden");
		manager.setFullscreenCopyOnSelect(false);
		await manager.flush();
		const savedSettings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
		expect(savedSettings.fullscreenExitOutput).toBe("resume-hint");
		expect(savedSettings.fullscreenScrollbar).toBe("hidden");
		expect(savedSettings.fullscreenCopyOnSelect).toBe(false);

		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ fullscreenExitOutput: "nothing", fullscreenScrollbar: "sometimes" }),
		);
		const reloadedManager = SettingsManager.create(projectDir, agentDir);
		expect(reloadedManager.getFullscreenExitOutput()).toBe("transcript");
		expect(reloadedManager.getFullscreenScrollbar()).toBe("auto");
		expect(reloadedManager.getFullscreenCopyOnSelect()).toBe(true);
	});

	// #9758: wheel scrolling defaults to auto, persists line counts, and ignores invalid values.
	it("persists fullscreen wheel scroll lines", async () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getFullscreenWheelScrollLines()).toBe("auto");

		manager.setFullscreenWheelScrollLines(3);
		await manager.flush();
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")).fullscreenWheelScrollLines).toBe(3);

		for (const [value, expected] of [
			[7.9, 7],
			[0, 1],
			[1000, 100],
			["fast", "auto"],
			[null, "auto"],
		] as const) {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ fullscreenWheelScrollLines: value }));
			expect(SettingsManager.create(projectDir, agentDir).getFullscreenWheelScrollLines()).toBe(expected);
		}
	});

	describe("outputPad", () => {
		it("should default to 1 and persist binary values", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getOutputPad()).toBe(1);

			manager.setOutputPad(0);
			await manager.flush();

			expect(manager.getOutputPad()).toBe(0);
			const savedSettings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
			expect(savedSettings.outputPad).toBe(0);
		});

		it("should treat unsupported outputPad values as default padding", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ outputPad: 2 }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getOutputPad()).toBe(1);
		});
	});

	describe("markdown.mermaid", () => {
		it("defaults to streaming and persists rendering modes", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getMermaidRenderingMode()).toBe("streaming");

			manager.setMermaidRenderingMode("final");
			await manager.flush();

			expect(manager.getMermaidRenderingMode()).toBe("final");
			const savedSettings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
			expect(savedSettings.markdown.mermaid).toBe("final");
		});

		it("falls back to streaming for unsupported values", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ markdown: { mermaid: "sometimes" } }));

			expect(SettingsManager.create(projectDir, agentDir).getMermaidRenderingMode()).toBe("streaming");
		});
	});

	describe("shellCommandPrefix", () => {
		it("should load shellCommandPrefix from settings", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ shellCommandPrefix: "shopt -s expand_aliases" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getShellCommandPrefix()).toBe("shopt -s expand_aliases");
		});

		it("should return undefined when shellCommandPrefix is not set", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getShellCommandPrefix()).toBeUndefined();
		});

		it("should preserve shellCommandPrefix when saving unrelated settings", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ shellCommandPrefix: "shopt -s expand_aliases" }));

			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setTheme("light");
			await manager.flush();

			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.shellCommandPrefix).toBe("shopt -s expand_aliases");
			expect(savedSettings.theme).toBe("light");
		});
	});

	describe("defaultTools", () => {
		it("loads global defaults and lets project settings replace them", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultTools: ["read", "bash"] }));

			expect(SettingsManager.create(projectDir, agentDir).getDefaultTools()).toEqual(["read", "bash"]);

			writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ defaultTools: ["grep"] }));

			expect(SettingsManager.create(projectDir, agentDir).getDefaultTools()).toEqual(["grep"]);
		});

		it("preserves an empty tool list", () => {
			expect(SettingsManager.inMemory({ defaultTools: [] }).getDefaultTools()).toEqual([]);
			expect(SettingsManager.inMemory().getDefaultTools()).toBeUndefined();
		});

		it("applies +name and -name to the default selection", () => {
			expect(SettingsManager.inMemory({ defaultTools: ["+codemode", "-write"] }).getDefaultTools()).toEqual([
				"read",
				"bash",
				"edit",
				"codemode",
			]);
			expect(SettingsManager.inMemory({ defaultTools: ["read", "+grep", "+read"] }).getDefaultTools()).toEqual([
				"read",
				"grep",
			]);
		});

		it("layers project modifiers on top of the global selection", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ defaultTools: ["read", "bash", "+codemode"] }),
			);
			writeFileSync(
				join(projectDir, ".pi", "settings.json"),
				JSON.stringify({ defaultTools: ["-codemode", "+tool_search"] }),
			);

			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getDefaultTools()).toEqual(["read", "bash", "tool_search"]);

			manager.applyOverrides({ defaultTools: ["+codemode"] });
			expect(manager.getDefaultTools()).toEqual(["read", "bash", "tool_search", "codemode"]);
		});

		it("applies project modifiers to the built-in defaults without a global setting", () => {
			writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ defaultTools: ["+codemode"] }));

			expect(SettingsManager.create(projectDir, agentDir).getDefaultTools()).toEqual([
				"read",
				"bash",
				"edit",
				"write",
				"codemode",
			]);
		});
	});

	describe("getSessionDir", () => {
		it("should return undefined when not set", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBeUndefined();
		});

		it("should return global sessionDir", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessionDir: "/tmp/sessions" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBe("/tmp/sessions");
		});

		it("should return project sessionDir, overriding global", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessionDir: "/global/sessions" }));
			writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ sessionDir: "./sessions" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBe("./sessions");
		});

		it("should expand ~ in sessionDir", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessionDir: "~/sessions" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBe(join(homedir(), "sessions"));
		});
	});

	describe("getShellPath", () => {
		it("should return undefined when not set", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getShellPath()).toBeUndefined();
		});

		it("should return an absolute shellPath unchanged", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ shellPath: "/bin/zsh" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getShellPath()).toBe("/bin/zsh");
		});

		it("should expand ~ in shellPath", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ shellPath: "~/.local/bin/agent-shell-sandbox" }),
			);
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getShellPath()).toBe(join(homedir(), ".local/bin/agent-shell-sandbox"));
		});

		it("should expand a bare ~ in shellPath", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ shellPath: "~" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getShellPath()).toBe(homedir());
		});
	});
});
