import { describe, expect, it } from "vitest";
import { execFileNoStdin } from "../src/process.js";

const options = { encoding: "utf8" as const, timeout: 5000 };

function run(script: string, overrides: Partial<typeof options> = {}) {
	return execFileNoStdin(process.execPath, ["-e", script], {
		...options,
		...overrides,
	});
}

describe("execFileNoStdin", () => {
	it("provides EOF without a stdin socket and collects both output streams", async () => {
		const result = await run(
			'const fs = require("node:fs"); process.stdout.write(JSON.stringify({ socket: fs.fstatSync(0).isSocket(), input: fs.readFileSync(0, "utf8") })); process.stderr.write("diagnostic");',
		);
		expect(JSON.parse(result.stdout)).toEqual({ socket: false, input: "" });
		expect(result.stderr).toBe("diagnostic");
	});

	it("preserves output and the exit code on failure", async () => {
		await expect(
			run(
				'process.stdout.write("output"); process.stderr.write("reason"); process.exitCode = 7;',
			),
		).rejects.toMatchObject({
			code: 7,
			killed: false,
			signal: null,
			stdout: "output",
			stderr: "reason",
		});
	});

	it("kills commands that exceed the timeout", async () => {
		await expect(
			run("setInterval(() => {}, 1000)", { timeout: 100 }),
		).rejects.toMatchObject({
			code: null,
			killed: true,
			signal: "SIGTERM",
		});
	});

	it("preserves ENOENT when the executable does not exist", async () => {
		await expect(
			execFileNoStdin("/dsh-direnv-missing/executable", [], options),
		).rejects.toMatchObject({
			code: "ENOENT",
			stdout: "",
			stderr: "",
		});
	});

	it.each(["stdout", "stderr"] as const)(
		"enforces the %s buffer limit in bytes",
		async (stream) => {
			await expect(
				execFileNoStdin(
					process.execPath,
					["-e", `process.${stream}.write("éé")`],
					{
						...options,
						maxBuffer: 2,
					},
				),
			).rejects.toMatchObject({
				code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
				[stream]: "é",
			});
		},
	);
});
