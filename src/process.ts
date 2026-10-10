import {
	spawn,
	type ExecFileOptionsWithStringEncoding,
} from "node:child_process";

/** Run a command with stdin connected to /dev/null and buffered output. */
export function execFileNoStdin(
	file: string,
	args: readonly string[],
	options: ExecFileOptionsWithStringEncoding,
) {
	const { encoding, maxBuffer = 1024 * 1024, ...spawnOptions } = options;
	const child = spawn(file, args, {
		...spawnOptions,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const pending = new Promise<{ stdout: string; stderr: string }>(
		(resolve, reject) => {
			const output = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
			const lengths = { stdout: 0, stderr: 0 };
			let failure: (Error & { code?: string | number | undefined }) | undefined;

			for (const name of ["stdout", "stderr"] as const) {
				child[name].on("data", (chunk: Buffer) => {
					if (failure) return;
					const remaining = Math.max(0, maxBuffer - lengths[name]);
					output[name].push(chunk.subarray(0, remaining));
					lengths[name] += chunk.length;
					if (lengths[name] > maxBuffer) {
						failure = Object.assign(
							new RangeError(`${name} maxBuffer length exceeded`),
							{ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" },
						);
						child.kill(options.killSignal ?? "SIGTERM");
						child.stdout.destroy();
						child.stderr.destroy();
					}
				});
			}
			child.on("error", (error: NodeJS.ErrnoException) => {
				failure ??= error;
			});
			child.on("close", (code, signal) => {
				const stdout = Buffer.concat(output.stdout).toString(encoding);
				const stderr = Buffer.concat(output.stderr).toString(encoding);
				if (!failure && code === 0 && signal === null) {
					resolve({ stdout, stderr });
					return;
				}
				const cmd = [file, ...args].join(" ");
				const error = failure ?? new Error(`Command failed: ${cmd}\n${stderr}`);
				reject(
					Object.assign(error, {
						code: failure?.code ?? code,
						killed: child.killed,
						signal,
						cmd,
						stdout,
						stderr,
					}),
				);
			});
		},
	);
	return Object.assign(pending, { child });
}
