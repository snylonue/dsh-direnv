import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Run a command with stdin closed, preserving the native promise and errors. */
export function execFileNoStdin(
	file: string,
	args: readonly string[],
	options: ExecFileOptionsWithStringEncoding,
) {
	const pending = execFileAsync(file, args, options);
	pending.child?.stdin?.end();
	return pending;
}
