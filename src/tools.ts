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
 *   supplies the file contents and cannot approve anything by itself: it names a
 *   path, asks for user consent, and lets direnv perform the write.
 *   The tool is additionally confined to the
 *   calling agent's own workspace by default.
 *
 * - `direnv_reload` re-resolves one workspace (or every cached workspace) now,
 *   which explicitly replaces the saved workspace snapshot: use it after
 *   changing files, dependencies, or external direnv authorization, or to
 *   confirm what a workspace currently injects. It needs no approval — it only
 *   reads, never authorizes.
 *
 * @module dsh-direnv/tools
 */
import { dirname } from "node:path";
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
					"Ask the user to approve a workspace direnv file (.envrc or .env) so its variables load into future commands.",
					"Call it only when a command result carries a [dsh-direnv] blocked notice, or when the user explicitly asks.",
					"User approval is required; changing the file after direnv authorizes it requires a new approval.",
				].join(" "),
				parameters: {
					path: {
						type: "string",
						required: true,
						description:
							"Absolute path of the .envrc or .env file named in the [dsh-direnv] notice.",
					},
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
									path: { type: "string", required: true },
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
									path: { type: "string", required: true },
									detail: { type: "string", required: true },
								},
							},
						],
					},
					render: (_args, value) => [{ type: "text", text: value.detail }],
				},
				async execute(args, exec) {
					const path = args.path;
					const workspace =
						exec.agent === undefined
							? undefined
							: ctx.direnv.workspaceFor(exec.agent);

					// Validate BEFORE asking: never show a user a prompt for a path this
					// plugin would refuse anyway.
					const refusal = ctx.direnv.refusalFor(path, workspace);
					if (refusal !== undefined) {
						return {
							outcome: "refused" as const,
							path,
							detail: `dsh-direnv: refusing to approve: ${refusal}`,
						};
					}

					if (exec.agent === undefined) {
						return {
							outcome: "unavailable" as const,
							path,
							detail:
								"dsh-direnv: this call has no agent, so no user can be asked to approve it",
						};
					}
					const reason = [
						args.reason === undefined || args.reason.trim().length === 0
							? undefined
							: args.reason.trim(),
						`Approve this direnv file so its environment loads into future commands?`,
						`  path: ${path}`,
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
								path,
								detail: `dsh-direnv: the user rejected approving ${path}; the workspace environment stays unavailable`,
							};
						case "cancelled":
							return {
								outcome: "cancelled" as const,
								path,
								detail: `dsh-direnv: approval for ${path} was cancelled; the workspace environment stays unavailable`,
							};
						case "unavailable":
							return {
								outcome: "unavailable" as const,
								path,
								detail: `dsh-direnv: no approval answerer was reachable, so ${path} was not approved`,
							};
					}

					const approved = await ctx.direnv.approve(path, workspace);
					if (!approved.ok) {
						return {
							outcome: "refused" as const,
							path,
							detail: `dsh-direnv: the user approved, but direnv refused the write: ${approved.reason}`,
						};
					}
					// This explicit approval refreshes the fixed session workspace as well.
					const approvedDir = workspace ?? dirname(path);
					await ctx.direnv.reload(approvedDir);
					const after = ctx.direnv.statusFor(approvedDir);
					const variables = envNames(after.env).length;
					return {
						outcome: "approved" as const,
						path,
						variables,
						detail: [
							`dsh-direnv: approved ${path}.`,
							`The next command in this workspace receives ${variables} injected variable${variables === 1 ? "" : "s"}.`,
							...(after.kind === "injected"
								? []
								: [`Current state: ${ctx.direnv.describe(approvedDir)}.`]),
						].join(" "),
					};
				},
				presentCall: (args) => ({
					card: "generic",
					title: "Request direnv approval",
					kind: "execute",
					rawInput: args.path,
					content: [
						{
							type: "text",
							text:
								args.reason === undefined
									? args.path
									: `${args.path}\n${args.reason}`,
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
				"Re-resolve a workspace direnv environment now and report its current set/unset changes.",
				"Use it after changing workspace files, dependencies, or direnv authorization. Commands only read the last resolved snapshot. Omitting directory selects the current session workspace.",
				"Reads only: it never approves a file.",
			].join(" "),
			parameters: {
				directory: {
					type: "string",
					description:
						"Absolute path of the directory to re-resolve. Defaults to this agent's workspace root.",
				},
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						reloaded: { type: "integer", required: true },
						detail: { type: "string", required: true },
					},
				},
				render: (_args, value) => [{ type: "text", text: value.detail }],
			},
			async execute(args, exec) {
				const workspace =
					exec.agent === undefined
						? undefined
						: ctx.direnv.workspaceFor(exec.agent);
				const requested = args.directory;
				const target = requested ?? workspace;
				if (target === undefined) {
					return {
						reloaded: 0,
						detail:
							"dsh-direnv: this call has no workspace to reload; pass an explicit directory.",
					};
				}
				const report = await ctx.direnv.reload(target);
				const lines = report.changed.map((change) => {
					const where =
						change.rcPath === undefined ? change.directory : change.rcPath;
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
					return `  ${where}: ${change.kind}, ${String(change.variables)} variable(s)${suffix}`;
				});
				return {
					reloaded: report.reloaded,
					detail: [
						`dsh-direnv: reloaded ${String(report.reloaded)} workspace(s).`,
						...lines,
					].join("\n"),
				};
			},
			presentCall: (args) => ({
				card: "generic",
				title: "Reload direnv environment",
				kind: "execute",
				rawInput: args.directory ?? "",
				content: [
					{ type: "text", text: args.directory ?? "(current workspace)" },
				],
			}),
		}),
	);
}
