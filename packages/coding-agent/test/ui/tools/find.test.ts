import { expect, test } from "bun:test";
import { createRoot, isUiNode } from "@oh-my-pi/pi-tui";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import type { FindBoundedDetails } from "../../../src/tools/details/find";
import "../../../src/ui/styles/tools/find";
import { findPresenter } from "../../../src/ui/tools/find";
import { ToolBlock, ToolCall } from "../../../src/ui/transcript/tool-block";
import { toolScreenSuite } from "./presenter-corpus";
import { plainToolRows } from "./screens";

toolScreenSuite("find", "find", findPresenter);

test("find failures use one error prefix", () => {
	const env = staticEnvironment(loadThemeSync("dark", { symbolPreset: "ascii" }));
	const call = new ToolCall({ id: "find-1", name: "find", presenter: findPresenter, args: { query: "network" } });
	call.setExecutionStarted();
	call.updateResult({ content: [{ type: "text", text: "Error: index unavailable" }], isError: true }, false);
	expect(
		plainToolRows(call, env)
			.map(row => row.trimStart())
			.filter(Boolean),
	).toEqual(["[-] Error: index unavailable"]);
});

function extractLinkUris(text: string): string[] {
	return [...text.matchAll(/\x1b\]8;[^;]*;([^\x1b]+)(?:\x1b\\|\x07)/g)].map(match => match[1]!);
}

const bounded: FindBoundedDetails = {
	mode: "bounded",
	query: "who may join?",
	answerPresent: 0.12,
	verdict: "absent",
	results: [
		{
			path: "handbook.txt",
			resolved: "/repo/handbook.txt",
			startLine: 13,
			endLine: 13,
			score: 0.8,
			snippet: "2.1 Membership",
		},
		{
			path: "artifact://0",
			resolved: "artifact://0",
			startLine: 2,
			endLine: 4,
			score: 0.2,
			snippet: "the spill\tthreshold",
		},
	],
	coverage: {
		files: 2,
		passages: 30,
		windows: 1,
		passes: 1,
		finalistsDropped: 0,
		skipped: [{ path: "blob.bin", reason: "binary content" }],
	},
	verification: { verified: true, detail: "2 results re-read at the reported location" },
	provenance: [{ backend: "native", provider: "typesafe", model: "jev-1.13.0", distribution: "native" }],
	usage: { calls: 1, attempts: 1, input: 900, output: 4, costUsd: 0.0012 },
	elapsedMs: 800,
	cwd: "/repo",
};
const boundedArgs = { query: bounded.query, grep_keywords: [], paths: ["handbook.txt", "artifact://0", "blob.bin"] };

function boundedCall(expanded: boolean): ToolCall {
	const call = new ToolCall({ id: "find-b", name: "find", presenter: findPresenter, args: boundedArgs });
	call.setExecutionStarted();
	call.updateResult({ content: [{ type: "text", text: "" }], details: bounded }, false);
	if (expanded) call.setExpanded(true);
	return call;
}

test("bounded find rows link path:start-end and report answerPresent beside the ranking", () => {
	const theme = loadThemeSync("dark", { symbolPreset: "ascii" });
	const rows = plainToolRows(boundedCall(true), staticEnvironment(theme, { hyperlinks: true }), 200);
	const text = rows.join("\n");
	expect(text).toContain("handbook.txt:13");
	expect(text).toContain("artifact://0:2-4");
	// The presence verdict is its own signal: a top-ranked row coexists with a low answerPresent.
	expect(text).toContain("answerPresent 0.12 absent");
	expect(text).toContain("0.80");
	expect(text).toContain("1 skipped");
	expect(text).toContain("skipped blob.bin: binary content");
	expect(text).toContain("native judge typesafe/jev-1.13.0, native distribution");
	expect(text).toContain("2 results re-read at the reported location");
	expect(text).not.toContain("\t");
});

test("bounded find hyperlinks target the file under cwd and the internal URL", () => {
	const theme = loadThemeSync("dark", { symbolPreset: "ascii" });
	const call = boundedCall(true);
	const raw = createRoot(dispose => {
		try {
			const node = ToolBlock({ call });
			if (!isUiNode(node)) throw new Error("Expected a transcript tool node");
			return paintNode(staticEnvironment(theme, { hyperlinks: true }), node, 200).rows.join("\n");
		} finally {
			dispose();
		}
	});
	const uris = extractLinkUris(raw);
	expect(uris.filter(uri => uri.endsWith("/repo/handbook.txt") || uri.includes("/repo/handbook.txt"))).toHaveLength(1);
	expect(uris).toContain("artifact://0:2");
});

test("bounded find hides provenance and skip notices while collapsed", () => {
	const env = staticEnvironment(loadThemeSync("dark", { symbolPreset: "ascii" }));
	const text = plainToolRows(boundedCall(false), env, 200).join("\n");
	expect(text).toContain("answerPresent 0.12 absent");
	expect(text).toContain("1 skipped");
	expect(text).not.toContain("skipped blob.bin");
});

test("find call preview counts the bounded paths", () => {
	const env = staticEnvironment(loadThemeSync("dark", { symbolPreset: "ascii" }));
	const call = new ToolCall({ id: "find-c", name: "find", presenter: findPresenter, args: boundedArgs });
	expect(plainToolRows(call, env, 200).join("\n")).toContain("in 3 paths");
});
