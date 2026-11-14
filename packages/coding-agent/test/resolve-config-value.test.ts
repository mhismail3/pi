import childProcess from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	clearConfigValueCache,
	isCredentialReference,
	resolveConfigValue,
	resolveConfigValueAsync,
	resolveConfigValueUncached,
} from "../src/core/resolve-config-value.ts";
import * as shellModule from "../src/utils/shell.ts";

describe("resolveConfigValue", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-config-value-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		clearConfigValueCache();
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		clearConfigValueCache();
		vi.restoreAllMocks();
		syncBuiltinESMExports();
	});

	test("resolves literals, environment templates, and escapes", () => {
		process.env.TEST_CONFIG_LEFT = "left";
		process.env.TEST_CONFIG_RIGHT = "right";
		try {
			expect(resolveConfigValue("literal-key")).toBe("literal-key");
			expect(resolveConfigValue("$TEST_CONFIG_LEFT")).toBe("left");
			expect(resolveConfigValue("$" + "{TEST_CONFIG_LEFT}_$TEST_CONFIG_RIGHT")).toBe("left_right");
			expect(resolveConfigValue("$$TEST_CONFIG_LEFT")).toBe("$TEST_CONFIG_LEFT");
			expect(resolveConfigValue("$!literal-$TEST_CONFIG_RIGHT")).toBe("!literal-right");
		} finally {
			delete process.env.TEST_CONFIG_LEFT;
			delete process.env.TEST_CONFIG_RIGHT;
		}
	});

	test("uses credential-scoped environment before process.env", () => {
		process.env.TEST_CONFIG_SCOPED = "process";
		try {
			expect(resolveConfigValue("$TEST_CONFIG_SCOPED", { TEST_CONFIG_SCOPED: "credential" })).toBe("credential");
		} finally {
			delete process.env.TEST_CONFIG_SCOPED;
		}
	});

	test("executes shell commands and trims their output", () => {
		expect(resolveConfigValue("!echo '  spaced-key  '")).toBe("spaced-key");
		expect(resolveConfigValue("!printf 'line1\\nline2'")).toBe("line1\nline2");
		expect(resolveConfigValue("!echo 'hello world' | tr ' ' '-'")).toBe("hello-world");
	});

	test.each(["!exit 1", "!nonexistent-command-12345", "!printf ''"])(
		"returns undefined when command resolution fails: %s",
		(command) => {
			expect(resolveConfigValue(command)).toBeUndefined();
		},
	);

	test("caches successful and failed commands until explicitly cleared", () => {
		const counterFile = join(tempDir, "counter");
		writeFileSync(counterFile, "0");
		const escapedPath = counterFile.replace(/\\/g, "/").replace(/"/g, '\\"');
		const success = `!sh -c 'count=$(cat "${escapedPath}"); echo $((count + 1)) > "${escapedPath}"; echo value'`;

		expect(resolveConfigValue(success)).toBe("value");
		expect(resolveConfigValue(success)).toBe("value");
		expect(readFileSync(counterFile, "utf-8").trim()).toBe("1");

		clearConfigValueCache();
		expect(resolveConfigValue(success)).toBe("value");
		expect(readFileSync(counterFile, "utf-8").trim()).toBe("2");

		const failure = `!sh -c 'count=$(cat "${escapedPath}"); echo $((count + 1)) > "${escapedPath}"; exit 1'`;
		expect(resolveConfigValue(failure)).toBeUndefined();
		expect(resolveConfigValue(failure)).toBeUndefined();
		expect(readFileSync(counterFile, "utf-8").trim()).toBe("3");
	});

	test("does not cache environment values", () => {
		process.env.TEST_CONFIG_DYNAMIC = "first";
		try {
			expect(resolveConfigValue("$TEST_CONFIG_DYNAMIC")).toBe("first");
			process.env.TEST_CONFIG_DYNAMIC = "second";
			expect(resolveConfigValue("$TEST_CONFIG_DYNAMIC")).toBe("second");
		} finally {
			delete process.env.TEST_CONFIG_DYNAMIC;
		}
	});

	test("uncached resolution executes a command on every call", () => {
		const counterFile = join(tempDir, "uncached-counter");
		writeFileSync(counterFile, "0");
		const escapedPath = counterFile.replace(/\\/g, "/").replace(/"/g, '\\"');
		const command = `!sh -c 'count=$(cat "${escapedPath}"); echo $((count + 1)) > "${escapedPath}"; echo value'`;
		expect(resolveConfigValueUncached(command)).toBe("value");
		expect(resolveConfigValueUncached(command)).toBe("value");
		expect(readFileSync(counterFile, "utf-8").trim()).toBe("2");
	});

	test.skipIf(process.platform === "win32")(
		"keeps reference arguments inert and scrubs resolver failures",
		async () => {
			const executable = join(tempDir, "op");
			const recorded = join(tempDir, "argv.json");
			writeFileSync(
				executable,
				`#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(recorded)}, JSON.stringify(process.argv.slice(2)));\nprocess.stderr.write('private-child-diagnostic');\nprocess.exit(9);\n`,
			);
			chmodSync(executable, 0o700);
			const reference = "op://vault/item/field ; printf not-executed | $(echo unsafe) 'quoted'";
			expect(isCredentialReference({ source: "1password", reference })).toBe(true);
			await expect(
				resolveConfigValueAsync({ source: "1password", reference }, { opExecutable: executable }),
			).rejects.toThrow(/^Credential resolution failed$/);
			expect(JSON.parse(readFileSync(recorded, "utf8"))).toEqual(["read", "--no-newline", reference]);
			for (const invalid of [
				{ source: "1password", reference: "op://v/i/f\n" },
				{ source: "1password", reference: "!echo bad" },
				{ source: "1password", reference: "op://v/i/f", executable: "/bin/sh" },
				{ source: "keychain", service: "s", account: "a", format: "prefix" },
				{ source: "keychain", service: "s", account: "a\0" },
			])
				expect(isCredentialReference(invalid)).toBe(false);
			rmSync(recorded);
			await expect(
				resolveConfigValueAsync({ source: "1password", reference: "invalid" }, { opExecutable: executable }),
			).rejects.toThrow("Invalid credential reference");
			expect(existsSync(recorded)).toBe(false);
			await expect(
				resolveConfigValueAsync(
					{ source: "1password", reference: "op://v/i/f" },
					{ opExecutable: join(tempDir, "missing") },
				),
			).rejects.toThrow(/^Credential resolver unavailable$/);
		},
	);

	test.skipIf(process.platform === "win32")(
		"preserves successful reference bytes and fixed bearer formatting",
		async () => {
			const executable = join(tempDir, "op.cjs");
			const recorded = join(tempDir, "argv.json");
			const output = " \t\uFEFFfixture-雪\t ";
			writeFileSync(
				executable,
				`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(recorded)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(Buffer.from(${JSON.stringify(Buffer.from(output).toString("base64"))}, 'base64'));\n`,
			);
			chmodSync(executable, 0o700);
			const reference = "op://vault/item/field ; $() | 'quoted'";
			expect(await resolveConfigValueAsync({ source: "1password", reference }, { opExecutable: executable })).toBe(
				output,
			);
			expect(JSON.parse(readFileSync(recorded, "utf8"))).toEqual(["read", "--no-newline", reference]);
			expect(
				await resolveConfigValueAsync(
					{ source: "1password", reference, format: "bearer" },
					{ opExecutable: executable },
				),
			).toBe(`Bearer ${output}`);
		},
	);

	test.skipIf(process.platform === "win32")("rejects malformed output without leaking or normalizing it", async () => {
		const executable = join(tempDir, "op.cjs");
		for (const output of [
			Buffer.alloc(0),
			Buffer.from("\nprivate-fixture\n"),
			Buffer.from("private-fixture\r\n"),
			Buffer.from("private-fixture\0"),
			Buffer.from([0xc3, 0x28]),
		]) {
			writeFileSync(
				executable,
				`#!${process.execPath}\nprocess.stdout.write(Buffer.from(${JSON.stringify(output.toString("base64"))}, 'base64'));\n`,
			);
			chmodSync(executable, 0o700);
			await expect(
				resolveConfigValueAsync({ source: "1password", reference: "op://v/i/f" }, { opExecutable: executable }),
			).rejects.toThrow(/^Credential resolution failed$/);
		}
	});

	test.skipIf(process.platform !== "darwin")(
		"uses Keychain argv and removes only its single CLI terminator with an inert child",
		async () => {
			const executable = join(tempDir, "security.cjs");
			const recorded = join(tempDir, "argv.json");
			const realSpawn = childProcess.spawn;
			vi.spyOn(childProcess, "spawn").mockImplementation((command, args, options) => {
				expect(command).toBe("/usr/bin/security");
				return realSpawn(executable, args, options);
			});
			syncBuiltinESMExports();
			for (const [output, expected] of [
				[" \tfixture \t\n", " \tfixture \t"],
				["private-fixture\n\n", undefined],
				["private-fixture\r\n", undefined],
			] as const) {
				writeFileSync(
					executable,
					`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(recorded)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(${JSON.stringify(output)});\n`,
				);
				chmodSync(executable, 0o700);
				const result = resolveConfigValueAsync({
					source: "keychain",
					service: "service ; $()",
					account: "account 'quoted'",
				});
				if (expected === undefined) await expect(result).rejects.toThrow(/^Credential resolution failed$/);
				else expect(await result).toBe(expected);
				expect(JSON.parse(readFileSync(recorded, "utf8"))).toEqual([
					"find-generic-password",
					"-s",
					"service ; $()",
					"-a",
					"account 'quoted'",
					"-w",
				]);
			}
		},
	);

	test.skipIf(process.platform === "win32")(
		"refuses pre-abort without starting a child and joins immediate cancellation",
		async () => {
			const executable = join(tempDir, "op.cjs");
			const marker = join(tempDir, "started");
			writeFileSync(
				executable,
				`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`,
			);
			chmodSync(executable, 0o700);
			const realSpawn = childProcess.spawn;
			const pids: number[] = [];
			const spawn = vi.spyOn(childProcess, "spawn").mockImplementation((command, args, options) => {
				const child = realSpawn(command, args, options);
				if (child.pid !== undefined) pids.push(child.pid);
				return child;
			});
			syncBuiltinESMExports();
			const pre = new AbortController();
			pre.abort();
			await expect(
				resolveConfigValueAsync(
					{ source: "1password", reference: "op://v/i/f" },
					{ opExecutable: executable, signal: pre.signal },
				),
			).rejects.toThrow(/^Credential resolution cancelled$/);
			expect(spawn).not.toHaveBeenCalled();
			expect(existsSync(marker)).toBe(false);
			const immediate = new AbortController();
			const result = resolveConfigValueAsync(
				{ source: "1password", reference: "op://v/i/f" },
				{ opExecutable: executable, signal: immediate.signal },
			);
			immediate.abort();
			await expect(result).rejects.toThrow(/^Credential resolution cancelled$/);
			expect(pids).toHaveLength(1);
			for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
		},
	);

	test.skipIf(process.platform === "win32")(
		"bounds output and joins the actual child on overflow and timeout",
		async () => {
			const executable = join(tempDir, "op");
			const pidFile = join(tempDir, "pid");
			writeFileSync(
				executable,
				`#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nif (process.argv.at(-1).endsWith('/overflow')) process.stdout.write('x'.repeat(65537));\nsetInterval(() => {}, 1000);\n`,
			);
			chmodSync(executable, 0o700);
			for (const mode of ["overflow", "timeout"]) {
				await expect(
					resolveConfigValueAsync(
						{ source: "1password", reference: `op://v/i/${mode}` },
						{ opExecutable: executable },
					),
				).rejects.toThrow(
					mode === "overflow" ? "Credential output exceeded limit" : "Credential resolution timed out",
				);
				const pid = Number(readFileSync(pidFile, "utf8"));
				expect(() => process.kill(pid, 0)).toThrow();
				rmSync(pidFile);
			}
		},
		15_000,
	);

	test("uses stdin when the configured Windows shell requires it", () => {
		if (process.platform === "win32") return;
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		vi.spyOn(shellModule, "getShellConfig").mockReturnValue({
			shell: "/bin/bash",
			args: ["-s"],
			commandTransport: "stdin",
		});
		try {
			Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
			const expansion = "$" + "{name}";
			expect(resolveConfigValueUncached(`!name='World'; echo "Hello, ${expansion}!"`)).toBe("Hello, World!");
		} finally {
			if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
		}
	});
});
