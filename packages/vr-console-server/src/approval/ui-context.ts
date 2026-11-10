/**
 * ConsoleUIContext — the in-process ExtensionUIContext the console supplies to omp
 * via `setToolUIContext(ctx, true)` (sdk.ts:4725). It implements a REAL `approve()`
 * (not just `select`), so every tool that reaches omp's approval gate
 * (ExtensionToolWrapper → requestApproval → ui.approve, approval.ts:869) renders a
 * first-class human card over the WebSocket.
 *
 * Fail-closed (approval.ts:842,879): anything but an explicit approval → "deny";
 * `session` only when the prompt offered it; a grant only one the prompt listed.
 *
 * The TUI-only surface (editor, themes, widgets, transcript redraw) is stubbed —
 * omp never calls those in a headless server; see the RpcExtensionUIContext
 * reference (modes/rpc/rpc-mode.ts:1517), which stubs the same methods.
 */
import type { ExtensionApprovalAnswer, ExtensionApprovalPrompt, ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";
import type { Broadcast, PendingRegistry } from "./pending";

/** Cap preview strings so a huge tool arg (file body, decompile) cannot bloat a frame.
 * TODO(Constraint 2): omp builds `full`/`compact`; this only truncates. Proper
 * redaction of research-bearing content (binary blobs, decompiles) is Increment 2 —
 * until then, run read-only tasks only, as the spike safety note requires. */
function cap(text: string, n = 4000): string {
	if (typeof text !== "string") return "";
	return text.length > n ? text.slice(0, n) + "\n…[truncated " + (text.length - n) + " chars]" : text;
}

/** Validate the browser's answer against the prompt; fail-closed to "deny". */
export function normalizeApprovalAnswer(answer: unknown, prompt: ExtensionApprovalPrompt): ExtensionApprovalAnswer {
	if (answer === "once" || answer === "deny") return answer;
	if (answer === "session") return prompt.session ? "session" : "deny";
	if (answer && typeof answer === "object") {
		const a = answer as { grant?: unknown; always?: unknown };
		if (a.grant === "folder" || a.grant === "target") {
			const offered = (prompt.grants ?? []).some(g => g.scope === a.grant);
			if (offered) return { grant: a.grant, always: a.always === true };
		}
	}
	return "deny";
}

export function createConsoleUIContext(broadcast: Broadcast, pending: PendingRegistry): ExtensionUIContext {
	const ctx = {
		timeoutStartsOnPresentation: false,
		supportsEditor: false,

		// ---- the real approval card ----
		async approve(prompt: ExtensionApprovalPrompt): Promise<ExtensionApprovalAnswer> {
			const answer = await pending.request("approval", {
				type: "approval_request",
				full: cap(prompt.full),
				compact: cap(prompt.compact, 400),
				session: prompt.session,
				grants: prompt.grants,
			});
			return normalizeApprovalAnswer(answer, prompt);
		},

		// ---- operator-facing dialogs (ask_operator rides input) ----
		async select(title: string, options: unknown[]): Promise<string | undefined> {
			const norm = options.map(o => (typeof o === "string" ? { label: o } : o));
			const v = await pending.request("select", { type: "select_request", title, options: norm });
			return typeof v === "string" ? v : undefined;
		},
		async confirm(title: string, message: string): Promise<boolean> {
			const v = await pending.request("confirm", { type: "confirm_request", title, message });
			return v === true;
		},
		async input(title: string, placeholder?: string): Promise<string | undefined> {
			const v = await pending.request("input", { type: "input_request", title, placeholder });
			return typeof v === "string" ? v : undefined;
		},
		notify(message: string, type?: "info" | "warning" | "error"): void {
			broadcast({ type: "notice", level: type ?? "info", message });
		},

		// ---- TUI-only surface: stubbed (never called headless) ----
		onTerminalInput(): () => void {
			return () => {};
		},
		rerenderMessage(): void {},
		refreshTranscript(): void {},
		getLinkClicksAvailable(): boolean {
			return false;
		},
		setStatus(): void {},
		setWorkingMessage(): void {},
		setWidget(): void {},
		setFooter(): void {},
		setHeader(): void {},
		setTitle(): void {},
		async custom(): Promise<never> {
			throw new Error("custom UI not supported in vr-console-server");
		},
		setEditorText(): void {},
		pasteToEditor(): void {},
		getEditorText(): string {
			return "";
		},
		async editor(): Promise<string | undefined> {
			return undefined;
		},
		addAutocompleteProvider(): void {},
		setEditorComponent(): void {},
		getEditorComponent(): undefined {
			return undefined;
		},
		get theme(): unknown {
			return {};
		},
		async getAllThemes(): Promise<{ name: string; path: string | undefined }[]> {
			return [];
		},
		async getTheme(): Promise<undefined> {
			return undefined;
		},
		async setTheme(): Promise<{ success: boolean; error?: string }> {
			return { success: false, error: "themes not supported in vr-console-server" };
		},
		getToolsExpanded(): boolean {
			return false;
		},
		setToolsExpanded(): void {},
	};
	return ctx as unknown as ExtensionUIContext;
}
