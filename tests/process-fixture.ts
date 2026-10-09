import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import type { ExportRun } from "../src/core.js";

/** A completed child process for mocking spawn, not the production service. */
export function completedChild(run: ExportRun): ChildProcess {
	const child = new ChildProcess();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	child.stdout = stdout;
	child.stderr = stderr;
	queueMicrotask(() => {
		stdout.end(run.stdout);
		stderr.end(run.stderr);
		child.emit("close", run.code, run.signal);
	});
	return child;
}
