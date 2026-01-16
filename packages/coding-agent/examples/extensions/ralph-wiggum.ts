/**
 * Ralph Wiggum Extension
 *
 * Implementation of the Ralph Wiggum technique for iterative, self-referential
 * AI development loops. Named after Ralph Wiggum from The Simpsons.
 *
 * The core concept: feed the same prompt to the agent repeatedly until a task
 * is complete. Each iteration sees the previous work in files, creating a
 * self-referential loop where the agent iteratively improves.
 *
 * Features:
 * - Multi-session support: automatically hands off to a new session when
 *   context window fills up (configurable threshold)
 * - Progress tracking via a plan file that gets updated before handoff
 * - Completion detection via <promise>TEXT</promise> tags
 *
 * Usage:
 *   /ralph "Build a REST API" --max-iterations 20 --completion-promise "DONE"
 *   /ralph "Execute the plan" --plan-file PLAN.md --context-threshold 60
 *   /cancel-ralph
 *
 * Based on: https://ghuntley.com/ralph/
 * Inspired by: https://github.com/anthropics/claude-code/tree/main/plugins/ralph-wiggum
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { calculateContextTokens, getLastAssistantUsage } from "@mariozechner/pi-coding-agent";

interface RalphState {
	active: boolean;
	prompt: string;
	iteration: number;
	totalIterations: number; // Across all sessions
	maxIterations: number;
	completionPromise: string | null;
	planFile: string | null;
	contextThreshold: number; // Percentage (0-100)
	startedAt: number;
	sessionCount: number;
	pendingHandoff: boolean; // True when we're waiting for plan update before handoff
}

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

function extractTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function extractPromiseText(text: string): string | null {
	const match = text.match(/<promise>\s*(.*?)\s*<\/promise>/s);
	return match ? match[1].trim() : null;
}

interface ParsedArgs {
	prompt: string;
	maxIterations: number;
	completionPromise: string | null;
	planFile: string | null;
	contextThreshold: number;
	error?: string;
}

function parseArgs(args: string): ParsedArgs {
	let remaining = args;
	let maxIterations = 0;
	let completionPromise: string | null = null;
	let planFile: string | null = null;
	let contextThreshold = 70; // Default 70%

	// Parse --max-iterations N
	const maxMatch = remaining.match(/--max-iterations\s+(\d+)/);
	if (maxMatch) {
		maxIterations = parseInt(maxMatch[1], 10);
		remaining = remaining.replace(maxMatch[0], "");
	}

	// Parse --context-threshold N
	const thresholdMatch = remaining.match(/--context-threshold\s+(\d+)/);
	if (thresholdMatch) {
		contextThreshold = Math.min(95, Math.max(10, parseInt(thresholdMatch[1], 10)));
		remaining = remaining.replace(thresholdMatch[0], "");
	}

	// Parse --plan-file PATH
	const planMatch = remaining.match(/--plan-file\s+(\S+)/);
	if (planMatch) {
		planFile = planMatch[1];
		remaining = remaining.replace(planMatch[0], "");
	}

	// Parse --completion-promise "TEXT" or --completion-promise 'TEXT'
	const promiseMatchDouble = remaining.match(/--completion-promise\s+"([^"]+)"/);
	const promiseMatchSingle = remaining.match(/--completion-promise\s+'([^']+)'/);
	const promiseMatchUnquoted = remaining.match(/--completion-promise\s+(\S+)/);

	if (promiseMatchDouble) {
		completionPromise = promiseMatchDouble[1];
		remaining = remaining.replace(promiseMatchDouble[0], "");
	} else if (promiseMatchSingle) {
		completionPromise = promiseMatchSingle[1];
		remaining = remaining.replace(promiseMatchSingle[0], "");
	} else if (promiseMatchUnquoted && !promiseMatchUnquoted[1].startsWith("-")) {
		completionPromise = promiseMatchUnquoted[1];
		remaining = remaining.replace(promiseMatchUnquoted[0], "");
	}

	// Check for unrecognized flags
	const unknownFlag = remaining.match(/--\S+/);
	if (unknownFlag) {
		return {
			prompt: "",
			maxIterations: 0,
			completionPromise: null,
			planFile: null,
			contextThreshold: 70,
			error: `Unknown option: ${unknownFlag[0]}`,
		};
	}

	const prompt = remaining.trim();

	return { prompt, maxIterations, completionPromise, planFile, contextThreshold };
}

function getContextUsagePercent(ctx: ExtensionContext): number | null {
	if (!ctx.model) return null;

	const entries = ctx.sessionManager.getEntries();
	const usage = getLastAssistantUsage(entries);
	if (!usage) return null;

	const contextTokens = calculateContextTokens(usage);
	const contextWindow = ctx.model.contextWindow;

	return Math.round((contextTokens / contextWindow) * 100);
}

export default function ralphWiggumExtension(pi: ExtensionAPI): void {
	let state: RalphState | null = null;

	function updateStatus(ctx: ExtensionContext): void {
		if (state?.active) {
			const max = state.maxIterations > 0 ? `/${state.maxIterations}` : "";
			const sessions = state.sessionCount > 1 ? ` (s${state.sessionCount})` : "";
			const contextPercent = getContextUsagePercent(ctx);
			const contextInfo = contextPercent !== null ? ` ${contextPercent}%` : "";
			ctx.ui.setStatus(
				"ralph",
				ctx.ui.theme.fg("warning", `🔄 Ralph ${state.totalIterations}${max}${sessions}${contextInfo}`),
			);
		} else {
			ctx.ui.setStatus("ralph", undefined);
		}
	}

	function persistState(): void {
		pi.appendEntry("ralph-state", state);
	}

	function showHelp(ctx: ExtensionContext): void {
		ctx.ui.notify(
			`Ralph Wiggum Loop

Usage:
  /ralph <prompt> [options]

Options:
  --max-iterations <n>        Stop after N iterations (default: unlimited)
  --completion-promise <text> Phrase that signals completion (use quotes)
  --plan-file <path>          Plan file to update before session handoff
  --context-threshold <n>     Context % before handoff (default: 70)

Examples:
  /ralph Build a todo API --max-iterations 20 --completion-promise "DONE"
  /ralph Execute the plan --plan-file PLAN.md --context-threshold 50
  /ralph Refactor the code (runs forever until /cancel-ralph)

Multi-session:
  When context reaches threshold, Ralph asks the agent to update the
  plan file with progress, then creates a new session and continues.

To complete:
  Output <promise>YOUR_PHRASE</promise> when the task is done.

Cancel:
  /cancel-ralph`,
			"info",
		);
	}

	pi.registerCommand("ralph", {
		description: "Start a Ralph Wiggum loop (iterative task completion)",
		handler: async (args, ctx) => {
			if (!args.trim() || args.includes("--help") || args.includes("-h")) {
				showHelp(ctx);
				return;
			}

			if (state?.active) {
				ctx.ui.notify(
					`Ralph loop already active (iteration ${state.totalIterations}). Use /cancel-ralph first.`,
					"warning",
				);
				return;
			}

			const parsed = parseArgs(args);

			if (parsed.error) {
				ctx.ui.notify(`Error: ${parsed.error}\n\nUse /ralph --help for usage.`, "error");
				return;
			}

			if (!parsed.prompt) {
				ctx.ui.notify("Error: No prompt provided.\n\nUse /ralph --help for usage.", "error");
				return;
			}

			state = {
				active: true,
				prompt: parsed.prompt,
				iteration: 1,
				totalIterations: 1,
				maxIterations: parsed.maxIterations,
				completionPromise: parsed.completionPromise,
				planFile: parsed.planFile,
				contextThreshold: parsed.contextThreshold,
				startedAt: Date.now(),
				sessionCount: 1,
				pendingHandoff: false,
			};

			persistState();
			updateStatus(ctx);

			// Show startup info
			const maxInfo = parsed.maxIterations > 0 ? parsed.maxIterations.toString() : "unlimited";
			const promiseInfo = parsed.completionPromise ?? "none (runs forever)";
			const planInfo = parsed.planFile ?? "none";

			let startupMsg = `🔄 Ralph loop activated!

Iteration: 1
Max iterations: ${maxInfo}
Completion promise: ${promiseInfo}
Plan file: ${planInfo}
Context threshold: ${parsed.contextThreshold}%`;

			if (parsed.completionPromise) {
				startupMsg += `\n\nTo complete, output: <promise>${parsed.completionPromise}</promise>`;
			}

			if (!parsed.completionPromise && parsed.maxIterations === 0) {
				startupMsg += "\n\n⚠️ WARNING: No exit condition! Use /cancel-ralph to stop.";
			}

			ctx.ui.notify(startupMsg, "info");

			// Send the initial prompt
			pi.sendUserMessage(parsed.prompt);
		},
	});

	pi.registerCommand("cancel-ralph", {
		description: "Cancel active Ralph loop",
		handler: async (_args, ctx) => {
			if (!state?.active) {
				ctx.ui.notify("No active Ralph loop.", "info");
				return;
			}

			const iterations = state.totalIterations;
			const sessions = state.sessionCount;
			const elapsed = Math.round((Date.now() - state.startedAt) / 1000);

			state = null;
			persistState();
			updateStatus(ctx);

			ctx.ui.notify(
				`🛑 Cancelled Ralph loop

Total iterations: ${iterations}
Sessions used: ${sessions}
Elapsed time: ${elapsed}s`,
				"info",
			);
		},
	});

	pi.registerCommand("ralph-status", {
		description: "Show Ralph loop status",
		handler: async (_args, ctx) => {
			if (!state?.active) {
				ctx.ui.notify("No active Ralph loop.", "info");
				return;
			}

			const elapsed = Math.round((Date.now() - state.startedAt) / 1000);
			const maxInfo = state.maxIterations > 0 ? state.maxIterations.toString() : "unlimited";
			const contextPercent = getContextUsagePercent(ctx);

			ctx.ui.notify(
				`🔄 Ralph Loop Status

Iteration: ${state.totalIterations}${state.maxIterations > 0 ? ` / ${state.maxIterations}` : ""} (session: ${state.iteration})
Sessions: ${state.sessionCount}
Max iterations: ${maxInfo}
Completion promise: ${state.completionPromise ?? "none"}
Plan file: ${state.planFile ?? "none"}
Context threshold: ${state.contextThreshold}%
Current context: ${contextPercent ?? "unknown"}%
Elapsed time: ${elapsed}s

Prompt:
${state.prompt}`,
				"info",
			);
		},
	});

	// Handle session handoff
	async function performHandoff(ctx: ExtensionCommandContext): Promise<void> {
		if (!state) return;

		const currentSessionFile = ctx.sessionManager.getSessionFile();

		ctx.ui.notify(`📦 Context threshold reached. Creating new session...`, "info");

		// Create new session with parent tracking
		const newSessionResult = await ctx.newSession({
			parentSession: currentSessionFile,
		});

		if (newSessionResult.cancelled) {
			ctx.ui.notify("Session handoff cancelled by extension", "warning");
			state.pendingHandoff = false;
			return;
		}

		// Update state for new session
		state.sessionCount++;
		state.iteration = 0; // Will be incremented to 1 when we send the prompt
		state.pendingHandoff = false;
		persistState();
		updateStatus(ctx);

		ctx.ui.notify(`🔄 Continuing Ralph loop in new session (session ${state.sessionCount})`, "info");

		// Continue the loop by sending the prompt
		state.iteration++;
		state.totalIterations++;
		persistState();

		// Inject context about the continuation
		const continueMsg = state.planFile
			? `🔄 Ralph loop continuing (session ${state.sessionCount}, iteration ${state.totalIterations}). Check ${state.planFile} for progress.`
			: `🔄 Ralph loop continuing (session ${state.sessionCount}, iteration ${state.totalIterations}). Check git history and files for previous progress.`;

		pi.sendMessage({ customType: "ralph-handoff", content: continueMsg, display: true }, { triggerTurn: false });

		pi.sendUserMessage(state.prompt);
	}

	// The core loop: after each agent response, check and potentially continue
	pi.on("agent_end", async (event, ctx) => {
		if (!state?.active) return;

		// If we were waiting for plan update before handoff, now do the handoff
		if (state.pendingHandoff) {
			// ctx in agent_end is ExtensionContext, but we need ExtensionCommandContext for newSession
			// We need to handle this differently - use a command or defer
			ctx.ui.notify("Plan updated. Use /ralph-handoff to continue in new session.", "info");
			return;
		}

		// Check max iterations
		if (state.maxIterations > 0 && state.totalIterations >= state.maxIterations) {
			const elapsed = Math.round((Date.now() - state.startedAt) / 1000);
			ctx.ui.notify(
				`🛑 Ralph loop: Max iterations (${state.maxIterations}) reached

Sessions used: ${state.sessionCount}
Elapsed time: ${elapsed}s`,
				"info",
			);

			state = null;
			persistState();
			updateStatus(ctx);
			return;
		}

		// Check completion promise in last assistant message
		if (state.completionPromise) {
			const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);

			if (lastAssistant) {
				const text = extractTextContent(lastAssistant);
				const promiseText = extractPromiseText(text);

				if (promiseText === state.completionPromise) {
					const elapsed = Math.round((Date.now() - state.startedAt) / 1000);
					ctx.ui.notify(
						`✅ Ralph loop complete!

Detected: <promise>${state.completionPromise}</promise>
Total iterations: ${state.totalIterations}
Sessions used: ${state.sessionCount}
Elapsed: ${elapsed}s`,
						"info",
					);

					state = null;
					persistState();
					updateStatus(ctx);
					return;
				}
			}
		}

		// Check context usage and trigger handoff if needed
		const contextPercent = getContextUsagePercent(ctx);
		if (contextPercent !== null && contextPercent >= state.contextThreshold) {
			if (state.planFile) {
				// Ask agent to update the plan file before handoff
				state.pendingHandoff = true;
				persistState();

				const updateMsg = `⚠️ Context window at ${contextPercent}% (threshold: ${state.contextThreshold}%).

Before continuing in a new session, please update ${state.planFile} with:
1. What has been completed so far
2. Current status of each task/phase
3. Any blockers or issues encountered
4. What remains to be done

After updating the file, the loop will continue in a fresh session.`;

				pi.sendMessage(
					{ customType: "ralph-context-warning", content: updateMsg, display: true },
					{ triggerTurn: false },
				);

				pi.sendUserMessage(`Update ${state.planFile} with current progress before session handoff.`);
				return;
			} else {
				// No plan file - just notify and continue (will compact eventually)
				ctx.ui.notify(
					`⚠️ Context at ${contextPercent}%. Consider using --plan-file for multi-session work.`,
					"warning",
				);
			}
		}

		// Continue the loop
		state.iteration++;
		state.totalIterations++;
		persistState();
		updateStatus(ctx);

		// Build iteration marker
		const iterInfo =
			state.maxIterations > 0 ? `${state.totalIterations}/${state.maxIterations}` : state.totalIterations.toString();

		let iterationMsg = `🔄 Ralph iteration ${iterInfo}`;
		if (state.completionPromise) {
			iterationMsg += ` | To complete: <promise>${state.completionPromise}</promise>`;
		}

		pi.sendMessage({ customType: "ralph-iteration", content: iterationMsg, display: true }, { triggerTurn: false });

		// Feed the SAME prompt back
		pi.sendUserMessage(state.prompt);
	});

	// Command to manually trigger handoff (needed because agent_end doesn't have newSession access)
	pi.registerCommand("ralph-handoff", {
		description: "Manually trigger Ralph session handoff",
		handler: async (_args, ctx) => {
			if (!state?.active) {
				ctx.ui.notify("No active Ralph loop.", "info");
				return;
			}

			if (!state.pendingHandoff) {
				const contextPercent = getContextUsagePercent(ctx);
				const confirm = await ctx.ui.confirm(
					"Force handoff?",
					`Context is at ${contextPercent ?? "unknown"}%. Create new session anyway?`,
				);
				if (!confirm) return;
			}

			state.pendingHandoff = true;
			await performHandoff(ctx);
		},
	});

	// Inject context about the loop when agent starts
	pi.on("before_agent_start", async () => {
		if (!state?.active) return;

		const iterInfo =
			state.maxIterations > 0 ? `${state.totalIterations}/${state.maxIterations}` : state.totalIterations.toString();

		let context = `[RALPH WIGGUM LOOP - Iteration ${iterInfo}, Session ${state.sessionCount}]

You are in a self-referential development loop. The same prompt is fed to you repeatedly until completion.

Your previous work persists in files - check git status and recent changes to see what you've done.`;

		if (state.planFile) {
			context += `

PROGRESS TRACKING: Check and update ${state.planFile} to track what's been done and what remains.`;
		}

		if (state.completionPromise) {
			context += `

COMPLETION: When the task is genuinely complete, output EXACTLY:
  <promise>${state.completionPromise}</promise>

IMPORTANT: Only output the promise when the statement is TRUE. Do not lie to exit the loop.`;
		}

		if (state.pendingHandoff) {
			context += `

⚠️ HANDOFF PENDING: Update the plan file with progress. A new session will be created after this turn.`;
		}

		return {
			message: {
				customType: "ralph-context",
				content: context,
				display: false,
			},
		};
	});

	// Restore state on session start/resume
	pi.on("session_start", async (_event, ctx) => {
		// Find the last ralph-state entry
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === "ralph-state") {
				state = (entry as { data: RalphState | null }).data;
			}
		}

		updateStatus(ctx);

		if (state?.active) {
			const iterInfo =
				state.maxIterations > 0
					? `${state.totalIterations}/${state.maxIterations}`
					: state.totalIterations.toString();
			ctx.ui.notify(`Resumed Ralph loop at iteration ${iterInfo} (session ${state.sessionCount})`, "info");

			// If we had a pending handoff, remind the user
			if (state.pendingHandoff) {
				ctx.ui.notify(`Handoff pending. Use /ralph-handoff to continue in new session.`, "warning");
			}
		}
	});
}
