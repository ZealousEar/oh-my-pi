/**
 * Bounded task context for semantic reduction: what the person asked for,
 * what they are asking for now, the latest progress, and the standing
 * requirements they stated along the way. Read locally from the session
 * branch; every field is head/tail-bounded and only the fields below ever
 * leave the machine (after egress preparation), never the transcript.
 *
 * `coverage` tells a producer whether it may act at all: with no user turn on
 * the branch there is nothing to judge against, so span-level reduction keeps
 * every possibly relevant line and region-level reduction abstains.
 */
import type { SessionEntry } from "../session/session-entries";

export interface TaskContext {
	/** Head of the first user request on the branch (after the latest compaction boundary). */
	originalRequest: string;
	/** Head of the latest user request. */
	latestRequest: string;
	/** Tail of the latest assistant reply (latest progress). */
	latestReply: string;
	/**
	 * Sentences from every user turn on the branch that state a retention,
	 * counting, or standing constraint (`keep every…`, `how many…`, `never…`),
	 * oldest first, deduplicated, bounded as a whole.
	 */
	requirements: string[];
	/** `full`: at least one user turn was read; `none`: no user turn on the branch. */
	coverage: "full" | "none";
}

export interface TaskContextOptions {
	/** Bound applied to each request/reply field and to the requirements as a whole. */
	maxChars: number;
	/** Entry id of the latest compaction's first kept entry; earlier turns are summarized away. */
	boundaryId?: string;
}

/**
 * Phrases that mark a sentence as a retention, counting, or standing requirement.
 * `each`/`every`/`all` count only beside a retention action (`keep every…`,
 * `report each…`) or an output noun (`every line`, `all entries`); negations
 * count only with a reduction verb (`don't truncate`). An ordinary "run each
 * migration in a transaction" or "don't tell anyone" is never collected.
 */
const REQUIREMENT_RE =
	/\b(?:count(?:s|ed|ing)?|how many|(?:total\s+)?number\s+of|(?:the\s+)?names?\s+(?:of|and)|their\s+names|enumerate|verbatim|full(?:\s+output)?|complete(?:\s+output)?|exact(?:ly)?|exhaustive|watch for|flag|(?:keep|retain|preserve|list|report|show|print|include|record|log|return|give)\s+(?:me\s+)?(?:all|every|each|the|those|these|them|everything|complete|full)\b|(?:every|each|all(?:\s+(?:of\s+)?the)?)\s+(?:line|entry|entries|item|name|result|file|package|warning|error|match|hit|record|row|output|batch|test|branch|commit|dependenc(?:y|ies)|module|director(?:y|ies)|folder|process(?:es)?|job|change|symbol|function|class|route|endpoint|key|value|field|column|table|version|host|port|url|path)s?\b|must|never|always|(?:do not|don'?t|no(?:t)?|without)\s+(?:truncat|prun|omit|drop|shorten|summari[sz]|skip|cut|remov|collaps|los)\w*)\b/iu;
const MAX_REQUIREMENT_SENTENCE_CHARS = 300;
/** Shortest requirement head worth keeping when the budget is nearly spent. */
const MIN_REQUIREMENT_HEAD_CHARS = 40;
const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+|\n+/u;

/** Text blocks of a user/assistant message, joined; images, thinking, and tool calls are not task context. */
export function messageText(content: string | ReadonlyArray<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) parts.push(block.text);
	}
	return parts.join("\n");
}

function head(text: string, limit: number): string {
	return text.length <= limit ? text : text.slice(0, limit);
}

function tail(text: string, limit: number): string {
	return text.length <= limit ? text : text.slice(text.length - limit);
}

/** Sentences of `text` that state a requirement, each bounded. */
export function requirementSentences(text: string): string[] {
	const found: string[] = [];
	for (const raw of text.split(SENTENCE_SPLIT_RE)) {
		const sentence = raw.trim();
		if (!sentence || !REQUIREMENT_RE.test(sentence)) continue;
		found.push(head(sentence, MAX_REQUIREMENT_SENTENCE_CHARS));
	}
	return found;
}

/** Collect the bounded task context from a session branch. */
export function collectTaskContext(entries: readonly SessionEntry[], options: TaskContextOptions): TaskContext {
	const limit = Math.max(0, options.maxChars);
	let start = 0;
	if (options.boundaryId !== undefined) {
		const boundary = entries.findIndex(entry => entry.id === options.boundaryId);
		// A boundary the branch does not contain means the caller's view of history is inconsistent:
		// fail closed (no coverage) rather than read summarized-away turns.
		if (boundary < 0)
			return { originalRequest: "", latestRequest: "", latestReply: "", requirements: [], coverage: "none" };
		start = boundary;
	}
	let originalRequest: string | undefined;
	let latestRequest: string | undefined;
	let latestReply: string | undefined;
	let latestReplyIndex = -1;
	const requirements: string[] = [];
	const seen = new Set<string>();
	let requirementChars = 0;
	for (let index = start; index < entries.length; index++) {
		const entry = entries[index];
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "user") {
			const text = messageText(message.content);
			if (!text.trim()) continue;
			if (originalRequest === undefined) originalRequest = text;
			latestRequest = text;
			for (const sentence of requirementSentences(text)) {
				if (seen.has(sentence)) continue;
				// A requirement that does not fit is kept as a head rather than dropped: the
				// retention gate must still see it. Below a readable head, stop collecting.
				const room = limit - requirementChars;
				if (room < MIN_REQUIREMENT_HEAD_CHARS) break;
				const bounded = head(sentence, room);
				seen.add(sentence);
				requirements.push(bounded);
				requirementChars += bounded.length;
			}
		} else if (message.role === "assistant") {
			const text = messageText(message.content);
			if (text.trim()) {
				latestReply = text;
				latestReplyIndex = index;
			}
		}
	}
	// A reply older than the latest request is not "latest progress" on it.
	if (latestRequest !== undefined && latestReplyIndex >= 0) {
		const requestIndex = entries.findLastIndex(
			entry =>
				entry.type === "message" &&
				entry.message.role === "user" &&
				messageText(entry.message.content) === latestRequest,
		);
		if (requestIndex > latestReplyIndex) latestReply = undefined;
	}
	return {
		originalRequest: head(originalRequest ?? "", limit),
		latestRequest: head(latestRequest ?? "", limit),
		latestReply: tail(latestReply ?? "", limit),
		requirements,
		coverage: latestRequest === undefined ? "none" : "full",
	};
}

/** Whether the person stated a requirement that routine-looking lines be retained or counted. */
export function hasRetentionRequirement(context: TaskContext): boolean {
	return context.requirements.length > 0;
}
