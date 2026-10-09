import type {
	ChildProcess,
	ExecFileOptionsWithStringEncoding,
	execFile,
} from "node:child_process";
import { promisify } from "node:util";
import { vi } from "vitest";

export interface CommandResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}

/** Keep execFile's custom promise shape while mocking its callback boundary. */
export function mockExecFile(actual: typeof execFile) {
	const mock = vi.fn((...args: Parameters<typeof actual>) => actual(...args));
	Object.defineProperty(mock, promisify.custom, {
		value: (
			file: string,
			args: readonly string[],
			options: ExecFileOptionsWithStringEncoding,
		) => {
			let child: ChildProcess | undefined;
			const pending = new Promise<{ stdout: string; stderr: string }>(
				(resolve, reject) => {
					child = mock(file, args, options, (error, stdout, stderr) => {
						if (error) reject(Object.assign(error, { stdout, stderr }));
						else resolve({ stdout: String(stdout), stderr: String(stderr) });
					});
				},
			);
			return Object.assign(pending, { child });
		},
	});
	return mock;
}

export function completeCommand(
	result: CommandResult,
	callback: Parameters<typeof execFile>[3],
	child: ChildProcess,
): ChildProcess {
	if (!callback) throw new Error("missing execFile callback");
	queueMicrotask(() => {
		const error =
			result.code === 0
				? null
				: Object.assign(new Error("command failed"), {
						code: result.code,
						killed: false,
						...(result.signal === null ? {} : { signal: result.signal }),
					});
		callback(error, result.stdout, result.stderr);
	});
	return child;
}
