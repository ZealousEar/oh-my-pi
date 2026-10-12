/*
 * Worker-side executor for one browser.task step. Rendered into the tab
 * runtime by renderFunctionRun, so it receives the real run scope
 * ({ tab, page, browser, wait, assert }) with a raw Puppeteer page.
 *
 * Every operation is one request/response: the host owns the loop, the budget,
 * and the decision; this file owns page contact. Guards are re-checked HERE,
 * immediately before input, because only the worker can observe the page
 * between the host's decision and the keystroke.
 *
 * Freshness and post-input settling are adapted from jev-ultrafast (MIT)
 * browser.py / snapshot.js.
 */
async ({ page }, request) => {
	const NAVIGATION_LOST = /execution context|detached|destroyed|target closed|session closed|navigat|frame was detached/i;
	const message = error => String((error && error.message) || error);
	const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

	// Document state + one control's guard signature, read together so the host
	// compares exactly what it observed.
	const readState = async node => {
		try {
			return await page.evaluate(n => {
				const cache = window.__ompBrowserTask;
				if (!cache || typeof cache.documentKey !== "function") return null;
				return {
					documentKey: cache.documentKey(),
					guard: typeof n === "number" ? (cache.guard(cache.nodes.get(n)) ?? null) : null,
				};
			}, node ?? null);
		} catch {
			return null;
		}
	};

	const resolveNode = async node => {
		const handle = await page.evaluateHandle(n => {
			const cache = window.__ompBrowserTask;
			return cache && cache.nodes ? cache.nodes.get(n) || null : null;
		}, node);
		const element = handle.asElement();
		if (!element) {
			await handle.dispose().catch(() => undefined);
			return null;
		}
		return element;
	};

	// Same actionability contract as the worker's own click path: rendered,
	// hit-testable, inside the viewport, and not covered.
	const actionable = el => {
		const element = el;
		if (!element.isConnected) return { ok: false, reason: "detached" };
		const style = getComputedStyle(element);
		if (style.display === "none") return { ok: false, reason: "display:none" };
		if (style.visibility === "hidden") return { ok: false, reason: "visibility:hidden" };
		if (style.pointerEvents === "none") return { ok: false, reason: "pointer-events:none" };
		if (Number(style.opacity) === 0) return { ok: false, reason: "opacity:0" };
		if (element.matches(":disabled") || element.getAttribute("aria-disabled") === "true") {
			return { ok: false, reason: "disabled" };
		}
		const rect = element.getBoundingClientRect();
		if (rect.width < 1 || rect.height < 1) return { ok: false, reason: "zero-size" };
		element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
		const box = element.getBoundingClientRect();
		const left = Math.max(0, Math.min(innerWidth, box.left));
		const right = Math.max(0, Math.min(innerWidth, box.right));
		const top = Math.max(0, Math.min(innerHeight, box.top));
		const bottom = Math.max(0, Math.min(innerHeight, box.bottom));
		if (right - left < 1 || bottom - top < 1) return { ok: false, reason: "off-viewport" };
		const x = Math.floor((left + right) / 2);
		const y = Math.floor((top + bottom) / 2);
		const topElement = document.elementFromPoint(x, y);
		if (!topElement) return { ok: false, reason: "elementFromPoint-null" };
		if (topElement === element || element.contains(topElement) || topElement.contains(element)) {
			return { ok: true, x, y };
		}
		return { ok: false, reason: "occluded" };
	};

	// Two clean animation frames, extended until an autocomplete listbox paints
	// when the field owns one. Bounded; a lost context is not an error here.
	const settle = async (node, kind, budgetMs) => {
		try {
			return await page.evaluate(
				input =>
					new Promise(resolve => {
						const cache = window.__ompBrowserTask;
						const field = cache && typeof input.node === "number" ? cache.nodes.get(input.node) : null;
						const autocomplete =
							input.kind === "TYPE_TEXT" &&
							!!field &&
							(field.getAttribute("role") === "combobox" ||
								!!field.getAttribute("aria-autocomplete") ||
								!!field.getAttribute("aria-controls") ||
								!!field.getAttribute("aria-owns"));
						let frames = 0;
						let stopped = false;
						const finish = reason => {
							if (stopped) return;
							stopped = true;
							resolve(reason);
						};
						setTimeout(() => finish("timeout"), input.budgetMs);
						const optionsPainted = () => {
							const ids = ((field && (field.getAttribute("aria-controls") || field.getAttribute("aria-owns"))) || "")
								.split(/\s+/)
								.filter(Boolean);
							const roots = ids.length
								? ids.map(id => document.getElementById(id)).filter(Boolean)
								: [document];
							return roots
								.flatMap(root => [...root.querySelectorAll('[role="option"]')])
								.some(option => {
									const rect = option.getBoundingClientRect();
									return (
										rect.width > 0 &&
										rect.height > 0 &&
										rect.bottom > 0 &&
										rect.top < innerHeight &&
										option.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
									);
								});
						};
						const tick = () => {
							if (stopped) return;
							if (++frames >= 2 && (!autocomplete || optionsPainted())) return finish("quiescent");
							requestAnimationFrame(tick);
						};
						requestAnimationFrame(tick);
					}),
				{ node: node ?? null, kind: kind ?? "", budgetMs: Math.max(1, budgetMs) },
			);
		} catch {
			return "context-lost";
		}
	};

	// WAIT: resolve on useful state - a combobox listbox arriving, document load
	// completing, or DOM mutation quiescence - never a fixed sleep.
	const waitUseful = async (node, budgetMs) => {
		try {
			return await page.evaluate(
				input =>
					new Promise(resolve => {
						const cache = window.__ompBrowserTask;
						const field = cache && typeof input.node === "number" ? cache.nodes.get(input.node) : null;
						const QUIET_MS = 150;
						let done = false;
						let quiet = null;
						let observer = null;
						let hard = null;
						const finish = reason => {
							if (done) return;
							done = true;
							if (observer) observer.disconnect();
							if (quiet) clearTimeout(quiet);
							if (hard) clearTimeout(hard);
							resolve(reason);
						};
						const optionsPainted = () => {
							const ids = ((field && (field.getAttribute("aria-controls") || field.getAttribute("aria-owns"))) || "")
								.split(/\s+/)
								.filter(Boolean);
							const roots = ids.length
								? ids.map(id => document.getElementById(id)).filter(Boolean)
								: [document];
							return roots
								.flatMap(root => [...root.querySelectorAll('[role="option"]')])
								.some(option => {
									const rect = option.getBoundingClientRect();
									return rect.width > 0 && rect.height > 0 && option.checkVisibility({ checkOpacity: true });
								});
						};
						const arm = () => {
							if (quiet) clearTimeout(quiet);
							quiet = setTimeout(() => finish("quiescent"), QUIET_MS);
						};
						hard = setTimeout(() => finish("timeout"), input.budgetMs);
						observer = new MutationObserver(() => {
							if (optionsPainted()) return finish("options");
							arm();
						});
						observer.observe(document.documentElement, {
							subtree: true,
							childList: true,
							attributes: true,
							characterData: true,
						});
						if (document.readyState !== "complete") {
							addEventListener("load", () => finish("load"), { once: true });
						}
						arm();
						if (optionsPainted()) finish("options");
					}),
				{ node: node ?? null, budgetMs: Math.max(1, budgetMs) },
			);
		} catch {
			return "context-lost";
		}
	};

	if (request.op === "observe") {
		if (request.settle) {
			await settle(request.settle.node ?? null, request.settle.kind ?? "", request.settle.budgetMs ?? 200);
		}
		let last = "";
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				const snapshot = await page.evaluate(request.script);
				if (snapshot) return { status: "ok", snapshot };
				last = "document had no body";
			} catch (error) {
				last = message(error);
			}
			await sleep(40);
		}
		return { status: "error", reason: "observation did not settle: " + last };
	}

	if (request.op === "fresh") {
		const state = await readState(request.node ?? null);
		return state ? { status: "ok", ...state } : { status: "ok", documentKey: null, guard: null };
	}

	if (request.op === "probe") {
		let selectorPresent = null;
		if (typeof request.selector === "string" && request.selector.length > 0) {
			try {
				const found = await page.$(request.selector);
				if (!found) selectorPresent = false;
				else {
					selectorPresent = await found.evaluate(el =>
						typeof el.checkVisibility === "function"
							? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
							: true,
					);
					await found.dispose().catch(() => undefined);
				}
			} catch (error) {
				return { status: "error", reason: "selector check failed: " + message(error) };
			}
		}
		return { status: "ok", url: page.url(), selectorPresent };
	}

	if (request.op !== "act") return { status: "error", reason: "unknown operation " + String(request.op) };

	const kind = request.kind;
	const settleMs = Math.max(1, Math.min(request.settleMs ?? 250, 3000));

	// Every dispatch is bound to the document it was decided against, SCROLL
	// and WAIT included: a page replaced while the host was deciding gets a
	// fresh observation, not an action meant for its predecessor.
	const documentStale = async () => {
		if (!request.expect) return null;
		const state = await readState(null);
		if (!state) return { status: "stale", reason: "page state is unreadable; the document was replaced" };
		if (state.documentKey !== request.expect.documentKey) {
			return { status: "stale", reason: "document state changed after the decision" };
		}
		return null;
	};

	if (kind === "SCROLL") {
		const stale = await documentStale();
		if (stale) return stale;
		try {
			const moved = await page.evaluate(delta => {
				const before = Math.round(scrollY);
				scrollBy(0, delta);
				return { before, after: Math.round(scrollY) };
			}, request.deltaY ?? 0);
			await settle(null, kind, settleMs);
			if (moved.before === moved.after) return { status: "rejected", reason: "page did not scroll" };
			return { status: "applied", detail: "scrolled to y=" + moved.after };
		} catch (error) {
			const text = message(error);
			return NAVIGATION_LOST.test(text)
				? { status: "unknown", reason: "page changed while scrolling: " + text }
				: { status: "rejected", reason: text };
		}
	}

	if (kind === "WAIT") {
		const stale = await documentStale();
		if (stale) return stale;
		const reason = await waitUseful(request.node ?? null, settleMs);
		return { status: "applied", detail: "wait:" + reason };
	}

	const element = await resolveNode(request.node);
	if (!element) return { status: "stale", reason: "the observed control is no longer in the page" };
	try {
		const state = await readState(request.node);
		if (!state) return { status: "stale", reason: "page state is unreadable; the document was replaced" };
		if (request.expect && state.documentKey !== request.expect.documentKey) {
			return { status: "stale", reason: "document state changed after the decision" };
		}
		if (request.expect && state.guard !== request.expect.guard) {
			return { status: "stale", reason: "the target control changed after the decision" };
		}
		const ready = await element.evaluate(actionable);
		if (!ready.ok) return { status: "stale", reason: "target is not actionable: " + ready.reason };

		let detail = "";
		try {
			if (kind === "CLICK") {
				await element.click();
				detail = "clicked";
			} else if (kind === "TYPE_TEXT") {
				const text = typeof request.text === "string" ? request.text : "";
				await element.focus();
				const mode = await element.evaluate(el => {
					if (el.isContentEditable) {
						const range = document.createRange();
						range.selectNodeContents(el);
						const selection = getSelection();
						selection.removeAllRanges();
						selection.addRange(range);
						return "range";
					}
					if (typeof el.select === "function") {
						el.select();
						return "select";
					}
					return "none";
				});
				if (mode === "none") {
					await page.keyboard.down(request.selectAllKey || "Control");
					await page.keyboard.press("KeyA");
					await page.keyboard.up(request.selectAllKey || "Control");
				}
				if (text.length === 0) await page.keyboard.press("Backspace");
				else await page.keyboard.type(text);
				detail = "typed " + text.length + " chars";
			} else if (kind === "SELECT") {
				const selected = await element.select(String(request.value ?? ""));
				if (!selected || selected.length === 0) {
					return { status: "rejected", reason: "select rejected value " + JSON.stringify(request.value) };
				}
				detail = "selected " + selected.join(", ");
			} else {
				return { status: "rejected", reason: "unsupported operation " + String(kind) };
			}
		} catch (error) {
			const text = message(error);
			// Input may or may not have landed; the host must re-observe and
			// reconcile rather than repeat the action.
			return NAVIGATION_LOST.test(text)
				? { status: "unknown", reason: "page changed while acting: " + text }
				: { status: "rejected", reason: text };
		}
		const settled = await settle(request.node, kind, settleMs);
		return { status: "applied", detail, settled };
	} finally {
		await element.dispose().catch(() => undefined);
	}
}
