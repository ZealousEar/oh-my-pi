import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";

export type Transferable = Bun.Transferable;

export interface ObservationEntry {
	id: number;
	role: string;
	name?: string;
	value?: string | number;
	description?: string;
	keyshortcuts?: string;
	states: string[];
}

export interface Observation {
	url: string;
	title?: string;
	viewport: { width: number; height: number; deviceScaleFactor?: number };
	scroll: {
		x: number;
		y: number;
		width: number;
		height: number;
		scrollWidth: number;
		scrollHeight: number;
	};
	elements: ObservationEntry[];
}

export interface ScreenshotResult {
	dest: string;
	mimeType: string;
	bytes: number;
	width: number;
	height: number;
}

export interface SessionSnapshot {
	cwd: string;
	browserScreenshotDir?: string;
	/** Force non-WebP screenshot encoding (e.g. for Ollama). Unset honors `OMP_NO_WEBP`. */
	excludeWebP?: boolean;
}

export type WorkerInitPayload =
	| {
			mode: "headless";
			browserWSEndpoint: string;
			safeDir: string;
			/** Keep the page tied to an OMP-owned worker without pinning a visible window's layout viewport. */
			emulateViewport?: boolean;
			viewport?: { width: number; height: number; deviceScaleFactor?: number };
			dialogs?: "accept" | "dismiss";
			/** Hostname patterns allowed for every page request. */
			allowedDomains?: string[];
			/** Document-start JavaScript sources registered before navigation. */
			initScripts?: string[];
			/** Absolute directory enabled for completed downloads. */
			downloadsPath?: string;
			/** Explicit tab user agent applied during worker initialization. */
			userAgent?: string;
			/** Ignore invalid HTTPS certificates for this page. */
			ignoreHttpsErrors?: boolean;
			url?: string;
			waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
			timeoutMs: number;
	  }
	| {
			mode: "attach";
			browserWSEndpoint: string;
			safeDir: string;
			targetId: string;
			dialogs?: "accept" | "dismiss";
			/** Hostname patterns allowed for every page request. */
			allowedDomains?: string[];
			/** Document-start JavaScript sources registered before navigation. */
			initScripts?: string[];
			/** Absolute directory enabled for completed downloads. */
			downloadsPath?: string;
			/** Explicit tab user agent applied during worker initialization. */
			userAgent?: string;
			/** Ignore invalid HTTPS certificates for this page. */
			ignoreHttpsErrors?: boolean;
			url?: string;
			waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
			timeoutMs: number;
			/**
			 * Post-timeout recycle: before adopting the page, dismiss any open JS dialog and
			 * stop a pending navigation so a blocked target cannot stall worker init (which
			 * previously force-killed the tab). Never set for first-time Electron attach.
			 */
			recover?: boolean;
			/** Restore focus emulation when recycling an OMP-owned tab, never a borrowed user tab. */
			emulateFocus?: boolean;
			/**
			 * Whether the worker may raise this tab before capturing a screenshot. Unset
			 * behaves as `true`; the supervisor clears it for browsers we did not launch.
			 */
			activateForScreenshot?: boolean;
			/**
			 * The supervisor created this target for omp (`app.new_tab` on a relay or
			 * connected browser). The worker closes it on `close`, like a headless
			 * page. Never set for an adopted user tab.
			 */
			ownsTarget?: boolean;
	  };

/** Result of one host tool requested by browser-run JavaScript. */
export type ToolReply = { ok: true; value: unknown } | { ok: false; error: RunErrorPayload };

/**
 * Authorization the worker must re-prove against the LIVE document immediately
 * before executing a non-raw mutation: the policy decided `action` for the
 * origin `target`; if the page has since moved to another origin (auto
 * navigation, the user, a redirect) the worker refuses without running.
 */
export interface RunBinding {
	target: string;
	action: string;
}

export type WorkerInbound =
	| { type: "init"; payload: WorkerInitPayload }
	| {
			type: "run";
			id: string;
			name: string;
			code: string;
			timeoutMs: number;
			session: SessionSnapshot;
			binding?: RunBinding;
	  }
	| { type: "abort"; id: string; expectedCleanup?: boolean }
	| { type: "tool-reply"; id: string; reply: ToolReply }
	| { type: "close" };

/** Exact origin for policy targets: `scheme://host[:port]`, `file:` for file URLs, `about:blank` when none. */
export function originOf(url: string | undefined): string {
	if (!url) return "about:blank";
	try {
		const parsed = new URL(url);
		if (parsed.protocol === "file:") return "file:";
		return parsed.origin === "null" ? "about:blank" : parsed.origin;
	} catch {
		return "about:blank";
	}
}

/**
 * Denial for a bound mutation whose page no longer matches the authorized
 * origin. Same shape as a policy denial so the prelude's re-prompt can offer
 * a scope for the origin the tab actually shows; `liveUrl` undefined means
 * the document could not be read (mid-navigation) — fail closed.
 */
export function targetChangedDenial(binding: RunBinding, liveUrl: string | undefined): string {
	const live = liveUrl === undefined ? "an unreadable document (navigation in flight)" : originOf(liveUrl);
	const needsScope = {
		surface: "browser",
		targets: [liveUrl === undefined ? binding.target : originOf(liveUrl)],
		actions: [binding.action],
		consequential: false,
	};
	return `AUTOMATION_DENIED: ${binding.action} was authorized for ${binding.target} but the tab now shows ${live}; nothing was dispatched — observe the current page and retry; needsScope=${JSON.stringify(needsScope)}`;
}

export interface ReadyInfo {
	url: string;
	title?: string;
	viewport: { width: number; height: number; deviceScaleFactor?: number };
	targetId: string;
}

export interface RunResultOk {
	displays: Array<TextContent | ImageContent>;
	returnValue: unknown;
	screenshots: ScreenshotResult[];
}

export interface RunErrorPayload {
	name: string;
	message: string;
	stack?: string;
	isToolError: boolean;
	isAbort: boolean;
	/** The worker could not restore tab-scoped browser state and must be recycled. */
	recoverTab?: boolean;
}

export type WorkerOutbound =
	| {
			/**
			 * Puppeteer loaded, browser connected. Sent before page acquisition so the supervisor's cold-start budget
			 * bounds only the realm setup (cold import + connect); page creation and the first navigation run under the
			 * ready wait.
			 */
			type: "setup";
	  }
	| {
			/**
			 * The headless page was created (before the potentially slow post-creation CDP work such as stealth and
			 * viewport). Lets the supervisor close exactly this target if it kills the worker during init — a killed
			 * worker can't clean up after itself.
			 */
			type: "page-created";
			targetId: string;
	  }
	| { type: "ready"; info: ReadyInfo }
	| { type: "init-failed"; error: RunErrorPayload }
	| { type: "result"; id: string; ok: true; payload: RunResultOk }
	| { type: "result"; id: string; ok: false; error: RunErrorPayload }
	| { type: "tool-call"; id: string; runId: string; name: string; args: unknown }
	| { type: "log"; level: "debug" | "warn" | "error"; msg: string; meta?: Record<string, unknown> }
	| { type: "closed" };

export interface Transport {
	send(msg: WorkerOutbound | WorkerInbound, transferList?: Transferable[]): void;
	onMessage(handler: (msg: WorkerOutbound | WorkerInbound) => void): () => void;
	close(): void;
}
