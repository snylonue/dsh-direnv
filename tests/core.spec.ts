/**
 * Core tests: validation, command execution, diff parsing, and refusals.
 * Command tests use the current Node binary; no direnv installation needed.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import {
	isAbsolutePath,
	assertAbsolutePath,
	parseExport,
	runExport,
	resolveStatus,
	selectInjectable,
	hasAppliedEntries,
	defaultConfig,
} from "../src/core.js";
import DirenvService from "../src/provider.js";

const created: string[] = [];
function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "dsh-direnv-core-"));
	created.push(dir);
	return dir;
}
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of created.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

describe("absolute path validation", () => {
	it("accepts absolute paths without inspecting files", () => {
		const value: unknown = "/missing/.envrc";
		if (!isAbsolutePath(value)) throw new Error("expected an absolute path");
		const path: string = value;
		expect(path).toBe("/missing/.envrc");
	});

	it("rejects invalid paths consistently", () => {
		for (const value of [undefined, null, 1, {}, "", ".envrc", "/ws/a\0b"])
			expect(isAbsolutePath(value)).toBe(false);
	});
	it("asserts the same path rules with a short fixed error", () => {
		const value: unknown = "/missing/.envrc";
		assertAbsolutePath(value);
		const path: string = value;
		expect(path).toBe("/missing/.envrc");
		for (const invalid of [null, 1, {}, "", ".envrc", "/ws/a\0b"])
			expect(() => assertAbsolutePath(invalid)).toThrow("invalid path");
	});
});

describe("native command execution", () => {
	function command(body: string): string {
		const workspace = scratch();
		writeFileSync(join(workspace, "export"), body);
		return workspace;
	}
	const config = { ...defaultConfig, executable: process.execPath };

	it("closes stdin and collects output without a shell", async () => {
		const workspace = command(
			'process.stdin.on("end", () => process.stdout.write("{}")); process.stdin.resume();',
		);
		await expect(runExport(workspace, config)).resolves.toMatchObject({
			stdout: "{}",
			stderr: "",
		});
	});

	it("keeps native exit errors but does not expose command output in status details", async () => {
		const workspace = command(
			'process.stdout.write("secret-value"); process.stderr.write("private-diagnostic"); process.exitCode = 7;',
		);
		await expect(runExport(workspace, config)).rejects.toMatchObject({
			code: 7,
			stdout: "secret-value",
			stderr: "private-diagnostic",
		});
		const status = await resolveStatus(workspace, config, null);
		expect(status.kind).toBe("error");
		expect(status.env).toEqual({});
		expect(status.detail).not.toContain("secret-value");
		expect(status.detail).not.toContain("private-diagnostic");
	});

	it("uses native authorization to distinguish a denied RC from an empty one", async () => {
		const workspace = command('process.stdout.write("{}");');
		const path = join(workspace, ".envrc");
		expect(
			(await resolveStatus(workspace, config, { path, allowed: 0 })).kind,
		).toBe("no-rc");
		expect(
			(await resolveStatus(workspace, config, { path, allowed: 2 })).kind,
		).toBe("denied");
	});

	it("returns blocked from native status without starting export", async () => {
		const workspace = scratch();
		await expect(
			resolveStatus(
				workspace,
				{ ...config, executable: "/missing/direnv" },
				{
					path: join(workspace, ".envrc"),
					allowed: 1,
				},
			),
		).resolves.toMatchObject({ kind: "blocked", env: {} });
	});

	it("does not classify an export failure by its stderr text", async () => {
		const workspace = command(
			'process.stderr.write("direnv: error RC is blocked. Run direnv allow"); process.exitCode = 1;',
		);
		const status = await resolveStatus(workspace, config, {
			path: join(workspace, ".envrc"),
			allowed: 0,
		});
		expect(status.kind).toBe("error");
		expect(status.env).toEqual({});
	});

	it("uses the native stdout buffer limit", async () => {
		const workspace = command(
			'process.stdout.write("x".repeat(9 * 1024 * 1024));',
		);
		await expect(runExport(workspace, config)).rejects.toMatchObject({
			code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
		});
	});
});

describe("parseExport", () => {
	it("parses a diff with string and null entries", () => {
		expect(parseExport('{"A":"1","B":null}')).toEqual({ A: "1", B: null });
	});

	it("treats empty output as an empty diff", () => {
		expect(parseExport("")).toEqual({});
		expect(parseExport("   \n ")).toEqual({});
	});

	it("rejects malformed, non-object, and non-string values", () => {
		expect(parseExport("not json")).toBeUndefined();
		expect(parseExport("[1,2]")).toBeUndefined();
		expect(parseExport('"a string"')).toBeUndefined();
		expect(parseExport('{"A":1}')).toBeUndefined();
		expect(parseExport('{"A":{"nested":true}}')).toBeUndefined();
	});
});

describe("selectInjectable", () => {
	it("keeps ordinary variables and drops DSH_*, DIRENV_*, and invalid names", () => {
		const { env, dropped } = selectInjectable({
			PATH: "/usr/bin",
			FOO: "bar",
			DSH_HOME: "/evil",
			DSH_SESSION_ID: "forged",
			DIRENV_DIFF: "opaque",
			"not-a-name": "x",
			"1LEADING": "x",
			"WITH SPACE": "x",
			"": "x",
		});
		expect(env).toEqual({ PATH: "/usr/bin", FOO: "bar" });
		expect(dropped.sort()).toEqual(
			[
				"",
				"1LEADING",
				"DIRENV_DIFF",
				"DSH_HOME",
				"DSH_SESSION_ID",
				"WITH SPACE",
				"not-a-name",
			].sort(),
		);
	});

	it("maps a null (unset) entry to undefined so the seam removes it", () => {
		// Omitting the name would be a bug: the executor merges this map onto the
		// scrubbed parent environment, so an absent name keeps the inherited value
		// and `unset FOO` in a .envrc would silently do nothing. `undefined` is
		// the subprocess seam's removal convention.
		const { env } = selectInjectable({ REMOVED: null, KEPT: "v" });
		expect(env).toEqual({ KEPT: "v", REMOVED: undefined });
		expect(Object.hasOwn(env, "REMOVED")).toBe(true);
	});

	it("still refuses to inject an unset for a managed or unsafe name", () => {
		const { env, dropped } = selectInjectable({
			DSH_HOME: null,
			"bad-name": null,
			GOOD: null,
		});
		expect(Object.keys(env)).toEqual(["GOOD"]);
		expect(env.GOOD).toBeUndefined();
		expect(dropped.sort()).toEqual(["DSH_HOME", "bad-name"]);
	});

	it("drops a value containing NUL instead of truncating it", () => {
		const { env, dropped } = selectInjectable({ BAD: "a\0b", GOOD: "x" });
		expect(env).toEqual({ GOOD: "x" });
		expect(dropped).toEqual(["BAD"]);
	});

	it("accepts an empty string as a genuine set-but-empty value", () => {
		expect(selectInjectable({ EMPTY: "" }).env).toEqual({ EMPTY: "" });
	});

	it("is case-sensitive about the managed namespace, dropping DSH_ but keeping dsh_", () => {
		// Native direnv variables are case-sensitive on POSIX; a lowercase name is
		// a different variable and cannot be read as a managed fact on this path.
		const { env, dropped } = selectInjectable({ DSH_X: "a", dsh_x: "b" });
		expect(env).toEqual({ dsh_x: "b" });
		expect(dropped).toEqual(["DSH_X"]);
	});
});

describe("hasAppliedEntries", () => {
	it("ignores the always-present DIRENV_* bookkeeping direnv emits", () => {
		// direnv emits these even for a denied or empty .envrc, so a raw
		// "is the diff empty" test would never detect the denied case.
		expect(
			hasAppliedEntries({
				DIRENV_DIFF: "x",
				DIRENV_DIR: "-/a",
				DIRENV_FILE: "/a/.envrc",
				DIRENV_WATCHES: "y",
			}),
		).toBe(false);
		expect(hasAppliedEntries({ DIRENV_DIFF: "x", REAL: "1" })).toBe(true);
		expect(hasAppliedEntries({})).toBe(false);
	});
});

describe("DirenvService activation", () => {
	it("loads and resolves a workspace without any execution service", async () => {
		const ctx = new Context();
		const fiber = await ctx.plugin(DirenvService, {
			...defaultConfig,
			enabled: false,
		});
		try {
			expect(ctx.get("shell")).toBeUndefined();
			expect(ctx.get("subprocess")).toBeUndefined();
			expect(ctx.get("direnv")).toBeInstanceOf(DirenvService);
			await expect(ctx.direnv.reload(scratch())).resolves.toMatchObject({
				kind: "disabled",
				variables: 0,
				added: [],
				removed: [],
			});
		} finally {
			await fiber.dispose();
		}
	});
});

describe("DirenvService.Config", () => {
	it("accepts the defaults and supplies omitted defaults", () => {
		expect(DirenvService.Config(defaultConfig)).toEqual(defaultConfig);
		expect(DirenvService.Config()).toEqual(defaultConfig);
		expect(DirenvService.Config().notifyOnBlocked).toBe(false);
	});

	it("accepts non-empty executable names and paths", () => {
		for (const executable of ["direnv", "/usr/bin/direnv"]) {
			expect(
				DirenvService.Config({ ...defaultConfig, executable }).executable,
			).toBe(executable);
		}
	});

	it("rejects empty or NUL-containing executable strings", () => {
		for (const executable of ["", "direnv\0", "\0direnv", "direnv\0\n"]) {
			expect(() =>
				DirenvService.Config({ ...defaultConfig, executable }),
			).toThrow();
		}
	});

	it("rejects non-positive, fractional, non-finite, and over-limit timeouts", () => {
		for (const probeTimeoutMs of [
			0,
			-1,
			1.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			600_001,
		]) {
			expect(() =>
				DirenvService.Config({ ...defaultConfig, probeTimeoutMs }),
			).toThrow(TypeError);
		}
	});
});
