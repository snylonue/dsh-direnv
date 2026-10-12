/**
 * Real-registry dispatch test for `direnv_allow`: the model reaches the tool
 * through `ctx.tools.execute`, so that path is exercised with the REAL tool
 * registry and a fake approval channel.
 *
 * @module tests/tool-dispatch
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Service } from "@deepseek-ai/cordis";
import { afterAll, describe, expect, it } from "vitest";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import DirenvService, { defaultConfig } from "../src/provider.js";
import * as AllowTool from "../src/tools.js";

const created: string[] = [];
function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "dsh-direnv-disp-"));
	created.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of created.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

let asked: string[] = [];
let answer: string = "allowed-once";
class FakeApproval extends Service {
	constructor(ctx: Context) {
		super(ctx, "approval");
	}
	request(req: { reason?: string }) {
		asked.push(req.reason ?? "");
		return Promise.resolve(answer);
	}
}

let currentAgent: unknown;
class FakeAgents extends Service {
	constructor(ctx: Context) {
		super(ctx, "agents");
	}
	currentInitiator(): unknown {
		return currentAgent;
	}
}

async function boot(withApproval = true) {
	const workspace = scratch();
	const rcPath = join(workspace, ".envrc");
	writeFileSync(rcPath, "export DISPATCH_TEST=1\n");
	const ctx = new Context();
	ctx.provide("shell", {
		resolve: () => ({}),
		execute: () => Promise.resolve({}),
	});
	const fibers = [] as Array<{ dispose(): Promise<void> }>;
	fibers.push(await ctx.plugin(ToolRuntime));
	fibers.push(await ctx.plugin(SystemPrompt, {}));
	fibers.push(await ctx.plugin(FakeAgents));
	if (withApproval) fibers.push(await ctx.plugin(FakeApproval));
	fibers.push(await ctx.plugin(DirenvService, { ...defaultConfig }));
	fibers.push(await ctx.plugin(AllowTool));
	asked = [];
	answer = "allowed-once";
	currentAgent = { session: { header: { cwd: workspace } } };
	return {
		ctx,
		workspace,
		rcPath,
		async dispose() {
			for (const f of fibers.reverse()) await f.dispose();
		},
	};
}

/** Dispatch one model-facing call through the real registry. */
async function dispatch(app: { ctx: Context }, args: Record<string, unknown>) {
	return app.ctx.tools.execute({
		callId: "call-dispatch-1",
		name: "direnv_allow",
		arguments: args,
		agent: currentAgent,
		signal: new AbortController().signal,
	} as never);
}

describe("direnv_allow through the real tool registry", () => {
	it("registers allow only while approval is available, without affecting reload", async () => {
		const app = await boot(false);
		try {
			const names = () => app.ctx.tools.schemas().map((schema) => schema.name);
			expect(names()).toContain("direnv_reload");
			expect(names()).not.toContain("direnv_allow");
			const approval = await app.ctx.plugin(FakeApproval);
			expect(names()).toContain("direnv_allow");
			await approval.dispose();
			expect(names()).not.toContain("direnv_allow");
			expect(names()).toContain("direnv_reload");
			const replacement = await app.ctx.plugin(FakeApproval);
			expect(names().filter((name) => name === "direnv_allow")).toHaveLength(1);
			await replacement.dispose();
		} finally {
			await app.dispose();
		}
	});

	it("is advertised to the model with only optional reason", async () => {
		const app = await boot();
		try {
			const schema = app.ctx.tools
				.schemas()
				.find((s) => s.name === "direnv_allow");
			expect(schema).toBeDefined();
			expect(schema?.description).toContain("approve");
			const params = schema?.parameters as {
				properties: Record<string, unknown>;
				required: string[];
			};
			expect(Object.keys(params.properties)).toEqual(["reason"]);
			expect(params.required ?? []).toEqual([]);
		} finally {
			await app.dispose();
		}
	});

	it("reaches the approval channel and approves on allowed-once", async () => {
		const app = await boot();
		try {
			const result = await dispatch(app, {
				reason: "needed for the build",
			});
			expect(asked).toHaveLength(1);
			expect(asked[0]).toContain(app.workspace);
			expect(asked[0]).toContain("needed for the build");
			expect(JSON.stringify(result)).toContain("approved");
		} finally {
			await app.dispose();
		}
	});

	it("reports a rejection as an ordinary result, not a thrown error", async () => {
		const app = await boot();
		try {
			answer = "rejected";
			const result = await dispatch(app, {});
			expect(JSON.stringify(result)).toContain("rejected");
		} finally {
			await app.dispose();
		}
	});

	it("allows native parent RC discovery after user consent", async () => {
		const app = await boot();
		try {
			const outside = scratch();
			const other = join(outside, ".envrc");
			writeFileSync(other, "export X=1\n");
			const nested = join(outside, "workspace");
			mkdirSync(nested);
			currentAgent = { session: { header: { cwd: nested } } };
			const result = await dispatch(app, {});
			expect(asked).toHaveLength(1);
			expect(asked[0]).toContain(nested);
			expect(JSON.stringify(result)).toContain("approved");
		} finally {
			await app.dispose();
		}
	});
});
