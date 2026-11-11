import { useEffect, useRef, useState } from "react";
import { connectWs, type WsHandle } from "../api";
import type { WsFrame } from "../types";

interface LogLine { cls: string; text: string }
interface Approval { id: string; full?: string; compact?: string; session?: string; grants?: { scope: string; label: string; alwaysLabel: string }[] }

function assistantDelta(ev: WsFrame): string | null {
	const a = ev.assistantMessageEvent as { delta?: { text?: string } | string; text?: string } | undefined;
	if (!a) return null;
	if (typeof a.delta === "object" && typeof a.delta?.text === "string") return a.delta.text;
	if (typeof a.text === "string") return a.text;
	if (typeof a.delta === "string") return a.delta;
	return null;
}

export function SessionPanel() {
	const [lines, setLines] = useState<LogLine[]>([]);
	const [approvals, setApprovals] = useState<Approval[]>([]);
	const [connected, setConnected] = useState(false);
	const [text, setText] = useState("");
	const wsRef = useRef<WsHandle | null>(null);
	const logRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const push = (cls: string, t: string) => setLines(prev => [...prev, { cls, text: t }]);
		const onFrame = (f: WsFrame) => {
			switch (f.type) {
				case "approval_request":
					setApprovals(prev => [...prev, f as unknown as Approval]);
					break;
				case "notice":
					push(`notice ${(f.level as string) || ""}`, `· ${f.message}`);
					break;
				case "message_update": {
					const d = assistantDelta(f);
					if (typeof d === "string") {
						setLines(prev => {
							const last = prev[prev.length - 1];
							if (last && last.cls === "assistant") return [...prev.slice(0, -1), { cls: "assistant", text: last.text + d }];
							return [...prev, { cls: "assistant", text: d }];
						});
					}
					break;
				}
				case "tool_execution_start":
					push("tool", `⚙ tool → ${f.toolName ?? "?"}`);
					break;
				case "message_start":
					if ((f.message as { role?: string })?.role === "assistant") push("assistant", "");
					break;
				case "turn_end":
					push("marker", "— turn end —");
					break;
				case "agent_end":
					push("marker", "— agent end —");
					break;
				default:
					break;
			}
		};
		wsRef.current = connectWs(onFrame, setConnected);
		return () => wsRef.current?.close();
	}, []);

	useEffect(() => {
		if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
	}, [lines]);

	const reply = (id: string, value: unknown) => {
		wsRef.current?.send({ type: "reply", id, value });
		setApprovals(prev => prev.filter(a => a.id !== id));
	};
	const send = () => {
		const t = text.trim();
		if (!t) return;
		setLines(prev => [...prev, { cls: "assistant", text: "" }, { cls: "notice", text: `› ${t}` }]);
		wsRef.current?.send({ type: "prompt", text: t });
		setText("");
	};

	return (
		<div className="split">
			<div>
				<div className="status" style={{ marginBottom: 8 }}>
					<span className={`dot ${connected ? "ok" : "off"}`} />
					{connected ? "connected" : "disconnected"} · approvals <b style={{ color: "var(--green)" }}>on</b> (always-ask)
				</div>
				{approvals.length > 0 && (
					<div className="approvals">
						{approvals.map(a => (
							<div key={a.id} className="appcard">
								<h4>⚠ Tool approval requested</h4>
								<pre>{a.full || a.compact || "(no detail)"}</pre>
								<div className="row">
									<button className="approve" onClick={() => reply(a.id, "once")}>Approve once</button>
									{a.session && <button className="session" onClick={() => reply(a.id, "session")}>{a.session}</button>}
									{(a.grants ?? []).map((g, i) => (
										<button key={i} className="session" onClick={() => reply(a.id, { grant: g.scope, always: false })}>{g.label}</button>
									))}
									<button className="deny" onClick={() => reply(a.id, "deny")}>Deny</button>
								</div>
							</div>
						))}
					</div>
				)}
				<div className="log" ref={logRef} style={{ height: approvals.length ? "calc(100vh - 360px)" : "calc(100vh - 260px)" }}>
					{lines.length === 0 && <div className="empty">No activity yet — send a prompt to start a turn. Tool calls raise approval cards above.</div>}
					{lines.map((l, i) => <div key={i} className={`l ${l.cls}`}>{l.text}</div>)}
				</div>
			</div>
			<div className="composer">
				<input
					value={text}
					placeholder="Prompt the agent…  (read-only tasks only while approval-text redaction is pending)"
					onChange={e => setText(e.target.value)}
					onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
				/>
				<button className="primary" onClick={send}>Send</button>
			</div>
		</div>
	);
}
