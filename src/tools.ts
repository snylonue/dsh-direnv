/**
 * Two model-facing tools:
 *
 * - `direnv_allow` asks the user to approve one workspace `.envrc`, then
 *   performs the approval with the host's own `direnv allow`. The consent path
 *   is DSH's own approval seam (`ctx.approval.request`), not a bespoke prompt:
 *   the request carries the agent, the tool identity, the exact call id, and a
 *   reason, and the composed answerer (the Web UI) renders it as a normal
 *   approval. Outcomes map exactly like the sandbox escalation precedent: only
 *   `allowed-once` proceeds, and every other outcome — rejection, cancellation,
 *   or an unavailable channel — refuses before anything runs. The model never
 *   supplies the file contents or target path: the session workspace selects the
 *   file, the user gives consent, and direnv performs the write.
 *   Native file discovery and validation are left to direnv in the calling
 *   agent's fixed session workspace.
 *
 * - `direnv_reload` re-resolves the calling session workspace now,
 *   which explicitly replaces the saved workspace snapshot: use it after
 *   changing files, dependencies, or external direnv authorization, or to
 *   confirm what a workspace currently injects. It needs no approval — it only
 *   reads, never authorizes.
 *
 * @module dsh-direnv/tools
 */
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type {} from "@deepseek-ai/dsh-user-approval";
import z from "@deepseek-ai/schemastery";
import { envNames } from "./core.js";

export const name = "direnv-tools";

/**
 * Both tools need the registry, prompt, and direnv provider. Only direnv_allow
 * waits for the approval service through a scoped inject; reload is independent.
 */
export const inject = ["tools", "systemPrompt", "direnv"];

/** No integration-local settings; behavior belongs to the provider row. */
export type Config = Record<string, never>;
export const Config = z.object({}) as z<Config>;

export function apply(ctx: Context): void {
	ctx.inject(["approval"], (ctx: Context) => {
		ctx.tools.register(
			defineTool({
				name: "direnv_allow",
				description: [
					"Ask the user to approve direnv for this session workspace so its variables load into future commands.",
					"Call it only when a command result carries a [dsh-direnv] blocked notice, or when the user explicitly asks.",
					"User approval is required; changing the file after direnv authorizes it requires a new approval.",
				].join(" "),
				parameters: {
					reason: {
						type: "string",
						description:
							"One short sentence explaining why this environment is needed.",
					},
				},
				output: {
					schema: {
						oneOf: [
							{
								type: "object",
								additionalProperties: false,
								properties: {
									outcome: {
										type: "string",
										required: true,
										const: "approved",
									},
									path: { type: "string" },
									variables: { type: "integer", required: true },
									detail: { type: "string", required: true },
								},
							},
							{
								type: "object",
								additionalProperties: false,
								properties: {
									outcome: {
										type: "string",
										required: true,
										enum: ["rejected", "cancelled", "unavailable", "refused"],
									},
									path: { type: "string" },
									detail: { type: "string", required: true },
								},
							},
						],
					},
					render: (_args, value) => [{ type: "text", text: value.detail }],
				},
				async execute(args, exec) {
					const workspace =
						exec.agent === undefined
							? undefined
							: ctx.direnv.workspaceFor(exec.agent);

					if (exec.agent === undefined || workspace === undefined) {
						return {
							outcome: "unavailable" as const,
							detail:
								"dsh-direnv: this call has no agent or session workspace to approve",
						};
					}
					const reason = [
						args.reason?.trim() || undefined,
						`Approve the direnv environment for this session workspace?`,
						`  workspace: ${workspace}`,
						"Changing the file after direnv authorizes it requires a new approval.",
					]
						.filter((part): part is string => part !== undefined)
						.join("\n");

					const outcome = await ctx.approval.request({
						agent: exec.agent,
						toolName: "direnv_allow",
						callId: exec.callId,
						reason,
						signal: exec.signal,
					});

					switch (outcome) {
						case "allowed-once":
							break;
						case "rejected":
							return {
								outcome: "rejected" as const,
								detail: `dsh-direnv: the user rejected approving ${workspace}; the workspace environment stays unavailable`,
							};
						case "cancelled":
							return {
								outcome: "cancelled" as const,
								detail: `dsh-direnv: approval for ${workspace} was cancelled; the workspace environment stays unavailable`,
							};
						case "unavailable":
							return {
								outcome: "unavailable" as const,
								detail: `dsh-direnv: no approval answerer was reachable, so ${workspace} was not approved`,
							};
					}

					const approved = await ctx.direnv.approve(workspace);
					if (!approved.ok) {
						return {
							outcome: "refused" as const,
							detail: `dsh-direnv: the user approved, but direnv refused the write: ${approved.reason}`,
						};
					}
					// This explicit approval refreshes the fixed session workspace as well.
					await ctx.direnv.reload(workspace);
					const after = ctx.direnv.statusFor(workspace);
					const variables = envNames(after.env).length;
					return {
						outcome: "approved" as const,
						...(after.rcPath === undefined ? {} : { path: after.rcPath }),
						variables,
						detail: [
							`dsh-direnv: approved ${workspace}.`,
							`The next command in this workspace receives ${variables} injected variable${variables === 1 ? "" : "s"}.`,
							...(after.kind === "injected"
								? []
								: [`Current state: ${ctx.direnv.describe(workspace)}.`]),
						].join(" "),
					};
				},
				presentCall: (args) => ({
					card: "generic",
					title: "Request direnv approval",
					kind: "execute",
					rawInput: args.reason ?? "",
					content: [
						{
							type: "text",
							text: args.reason ?? "(current workspace)",
						},
					],
				}),
			}),
		);
	});

	ctx.tools.register(
		defineTool({
			name: "direnv_reload",
			description: [
				"Re-resolve this session workspace direnv environment now and report its current set/unset changes.",
				"Use it after changing workspace files, dependencies, or direnv authorization. Commands only read the last resolved snapshot.",
				"Reads only: it never approves a file.",
			].join(" "),
			parameters: {},
			output: {
				schema: {
					oneOf: [
						{
							type: "object",
							additionalProperties: false,
							properties: {
								reloaded: { type: "integer", required: true },
								detail: {
									required: true,
									type: "object",
									additionalProperties: false,
									properties: {
										directory: { type: "string", required: true },
										rcPath: { type: "string" },
										kind: { type: "string", required: true },
										variables: { type: "integer", required: true },
										added: {
											type: "array",
											required: true,
											items: { type: "string" },
										},
										removed: {
											type: "array",
											required: true,
											items: { type: "string" },
										},
									},
								},
							},
						},
						{
							type: "object",
							additionalProperties: false,
							properties: { error: { type: "string", required: true } },
						},
					],
				},
				render: (_args, value) => {
					if ("error" in value) return [{ type: "text", text: value.error }];
					const change = value.detail;
					const where = change.rcPath ?? change.directory;
					const delta = [
						...(change.added.length === 0
							? []
							: [`+${change.added.join(",+")}`]),
						...(change.removed.length === 0
							? []
							: [`-${change.removed.join(",-")}`]),
					];
					const suffix =
						delta.length === 0 ? "" : ` (direnv: ${delta.join(" ")})`;
					return [
						{
							type: "text",
							text: [
								`dsh-direnv: reloaded ${String(value.reloaded)} workspace(s).`,
								`  ${where}: ${change.kind}, ${String(change.variables)} variable(s)${suffix}`,
							].join("\n"),
						},
					];
				},
			},
			async execute(_args, exec) {
				const workspace =
					exec.agent === undefined
						? undefined
						: ctx.direnv.workspaceFor(exec.agent);
				if (workspace === undefined) {
					return {
						error: "dsh-direnv: this call has no workspace to reload.",
					};
				}
				const detail = await ctx.direnv.reload(workspace);
				return { reloaded: 1, detail };
			},
			presentCall: () => ({
				card: "generic",
				title: "Reload direnv environment",
				kind: "execute",
				rawInput: "",
				content: [{ type: "text", text: "(current workspace)" }],
			}),
		}),
	);
}
