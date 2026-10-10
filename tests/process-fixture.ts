import type { ChildProcess, spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { vi } from "vitest";

export interface CommandResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}

export function mockSpawn(actual: typeof spawn) {
	return vi.fn((...args: Parameters<typeof actual>) => actual(...args));
}

export function completeCommand(
	result: CommandResult,
	child: ChildProcess,
): ChildProcess {
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	Object.assign(child, { stdin: null, stdout, stderr });
	queueMicrotask(() => {
		stdout.end(result.stdout);
		stderr.end(result.stderr);
		child.emit("close", result.code, result.signal);
	});
	return child;
}
