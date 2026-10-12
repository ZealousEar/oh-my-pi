/*
 * Atomic page reader for `tab.task`. ONE page.evaluate returns every visible
 * control with its accessible name, current value/state, geometry, occlusion,
 * native-select options, and a per-control guard signature - plus a
 * document-level state key and bounded visible text. Live DOM node identity is
 * retained in a page-side registry (window.__ompBrowserTask), so a later act
 * resolves the exact node that was observed instead of re-querying by text.
 *
 * Adapted from jev-ultrafast (MIT) snapshot.js; reworked for omp's control
 * schema: disabled controls are retained and flagged instead of dropped,
 * occlusion/hit points are reported rather than only used for filtering, and
 * guard signatures are strings so the host can compare them without structural
 * equality.
 *
 * Evaluated as an expression: returns the snapshot object, or null before the
 * document has a body.
 */
(() => {
	if (!document.body) return null;
	const cache = (window.__ompBrowserTask ||= { ids: new WeakMap(), nodes: new Map(), next: 1 });
	const TEXT_CAP = 6000;
	const CONTROL_CAP = 400;
	const LABEL_CAP = 200;
	const VALUE_CAP = 200;
	const OPTION_CAP = 60;
	const SCOPE_TEXT_CAP = 2000;

	const identity = element => {
		let id = cache.ids.get(element);
		if (id === undefined) {
			id = cache.next++;
			cache.ids.set(element, id);
		}
		cache.nodes.set(id, element);
		return id;
	};
	// Detached nodes can never be acted on again; drop them so the registry
	// tracks the live document rather than growing across navigations.
	for (const [id, element] of cache.nodes) if (!element.isConnected) cache.nodes.delete(id);

	// Roles whose visible text is a name, not a value: the host classifies
	// consequence from it even when an ARIA name says something else.
	const TEXT_IS_NAME = new Set([
		"button",
		"link",
		"checkbox",
		"radio",
		"switch",
		"tab",
		"menuitem",
		"menuitemradio",
		"menuitemcheckbox",
		"option",
		"gridcell",
	]);

	// Never surface (or type into) credential and file controls.
	const unsafe = element => ["password", "file", "hidden"].includes(element.type);
	const visible = element =>
		!element.closest('[aria-hidden="true"],[inert]') &&
		element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });

	const accessibleName = (element, seen = new Set()) => {
		if (!element || seen.has(element)) return "";
		seen.add(element);
		const referenced = (element.getAttribute("aria-labelledby") || "")
			.split(/\s+/)
			.filter(Boolean)
			.map(id => accessibleName(document.getElementById(id), seen))
			.filter(Boolean)
			.join(" ");
		return (
			referenced ||
			element.getAttribute("aria-label") ||
			[...(element.labels || [])]
				.map(label => accessibleName(label, seen))
				.filter(Boolean)
				.join(" ") ||
			(["button", "submit", "reset"].includes(element.type) ? element.value : "") ||
			element.getAttribute("alt") ||
			(element.tagName === "INPUT"
				? ""
				: [...element.childNodes]
						.map(node =>
							node.nodeType === 3
								? node.textContent
								: node.nodeType === 1 && node.getAttribute("aria-hidden") !== "true"
									? accessibleName(node, seen)
									: "",
						)
						.join(" ")
						.trim()) ||
			element.getAttribute("title") ||
			element.getAttribute("placeholder") ||
			""
		);
	};

	const ROLES = [
		"button",
		"link",
		"checkbox",
		"radio",
		"switch",
		"tab",
		"menuitem",
		"menuitemradio",
		"menuitemcheckbox",
		"option",
		"gridcell",
		"combobox",
		"textbox",
		"searchbox",
		"spinbutton",
	];
	const SELECTOR =
		'a[href],button,input,textarea,select,summary,[contenteditable="true"],' +
		ROLES.map(role => '[role="' + role + '"]').join(",");

	const roleOf = element => {
		const explicit = element.getAttribute("role");
		if (ROLES.includes(explicit)) return explicit;
		if (element.tagName === "BUTTON" || element.tagName === "SUMMARY") return "button";
		if (element.tagName === "A") return "link";
		if (element.tagName === "SELECT") return "select";
		if (element.tagName === "TEXTAREA" || element.isContentEditable) return "textbox";
		if (element.tagName === "INPUT") {
			if (["checkbox", "radio"].includes(element.type)) return element.type;
			if (["button", "submit", "reset", "image"].includes(element.type)) return "button";
			if (element.type === "search") return "searchbox";
			if (element.type === "number") return "spinbutton";
			if (["text", "email", "url", "tel", "date", "time", "datetime-local", "month", "week"].includes(element.type))
				return "textbox";
			return null;
		}
		return null;
	};

	const isDisabled = element =>
		(typeof element.matches === "function" && element.matches(":disabled")) ||
		element.getAttribute("aria-disabled") === "true";

	const clean = (value, cap) =>
		String(value ?? "")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, cap);

	// Everything an action's meaning depends on: identity, semantics, current
	// value/state, and the surrounding text scope. A changed signature means the
	// control the model chose is no longer the control that is there.
	const guard = element => {
		if (!element || !element.isConnected || !visible(element)) return null;
		const scope = element.closest('form,dialog,[role="dialog"],article,li,tr,[role="row"]') || element.parentElement;
		return JSON.stringify([
			identity(element),
			roleOf(element),
			clean(accessibleName(element), LABEL_CAP),
			element.value ?? null,
			element.checked ?? null,
			element.selectedIndex ?? null,
			element.readOnly ?? null,
			isDisabled(element),
			element.getAttribute("aria-expanded"),
			element.getAttribute("aria-checked"),
			element.getAttribute("aria-selected"),
			element.getAttribute("href"),
			scope && scope.innerText ? scope.innerText.slice(0, SCOPE_TEXT_CAP) : "",
		]);
	};

	// Document-level state: navigation, scroll, geometry, and every editable
	// field's value. Cheap to recompute and enough to prove "nothing moved".
	const documentKey = () =>
		JSON.stringify([
			performance.timeOrigin,
			location.href,
			document.title,
			Math.round(scrollX),
			Math.round(scrollY),
			innerWidth,
			innerHeight,
			[...document.querySelectorAll("input,textarea,select")]
				.filter(element => !unsafe(element))
				.map(element => [
					identity(element),
					element.value ?? null,
					element.checked ?? null,
					element.selectedIndex ?? null,
					isDisabled(element),
					element.readOnly ?? null,
				]),
		]);

	cache.guard = guard;
	cache.documentKey = documentKey;

	const controls = [];
	let matched = 0;
	let hidden = 0;
	for (const element of document.querySelectorAll(SELECTOR)) {
		if (unsafe(element)) continue;
		const role = roleOf(element);
		if (!role) continue;
		matched++;
		if (!visible(element)) {
			hidden++;
			continue;
		}
		const rect = element.getBoundingClientRect();
		if (rect.width < 1 || rect.height < 1) {
			hidden++;
			continue;
		}
		if (controls.length >= CONTROL_CAP) continue;
		const control = {
			node: identity(element),
			role,
			label: clean(accessibleName(element), LABEL_CAP),
			enabled: !isDisabled(element) && element.readOnly !== true,
			multiline: element.tagName === "TEXTAREA" || element.isContentEditable === true,
			bbox: {
				x: Math.round(rect.left),
				y: Math.round(rect.top),
				w: Math.round(rect.width),
				h: Math.round(rect.height),
			},
			inViewport: rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth,
			occluded: false,
		};
		if (control.inViewport) {
			const left = Math.max(0, Math.min(innerWidth, rect.left));
			const right = Math.max(0, Math.min(innerWidth, rect.right));
			const top = Math.max(0, Math.min(innerHeight, rect.top));
			const bottom = Math.max(0, Math.min(innerHeight, rect.bottom));
			if (right - left >= 1 && bottom - top >= 1) {
				const x = Math.floor((left + right) / 2);
				const y = Math.floor((top + bottom) / 2);
				const topElement = document.elementFromPoint(x, y);
				control.occluded = !(
					topElement &&
					(topElement === element || element.contains(topElement) || topElement.contains(element))
				);
				control.hit = { x, y };
			} else {
				control.inViewport = false;
			}
		}
		if (element.tagName === "SELECT") {
			control.value = clean(element.value, VALUE_CAP);
			const current = element.selectedIndex >= 0 ? element.options[element.selectedIndex] : null;
			control.selectedLabel = current ? clean(current.textContent || current.value, LABEL_CAP) : "";
			control.multiple = element.multiple === true;
			control.options = [...element.options].slice(0, OPTION_CAP).map(option => ({
				value: option.value,
				label: clean(option.textContent || option.value, LABEL_CAP),
				disabled: option.disabled === true,
				selected: option.selected === true,
			}));
			control.optionsOmitted = Math.max(0, element.options.length - OPTION_CAP);
		} else if (element.isContentEditable) {
			control.value = clean(element.textContent, VALUE_CAP);
		} else if (typeof element.value === "string") {
			control.value = clean(element.value, VALUE_CAP);
		}
		if (typeof element.checked === "boolean") control.checked = element.checked;
		const expanded = element.getAttribute("aria-expanded");
		if (expanded !== null) control.expanded = expanded === "true";
		const selected = element.getAttribute("aria-selected");
		if (selected !== null) control.selected = selected === "true";
		const placeholder = element.getAttribute("placeholder");
		if (placeholder) control.placeholder = clean(placeholder, LABEL_CAP);
		if (
			TEXT_IS_NAME.has(role) &&
			!["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName) &&
			!element.isContentEditable
		) {
			const text = clean(element.innerText, LABEL_CAP);
			if (text) control.text = text;
		}
		const ariaLabel = element.getAttribute("aria-label");
		if (ariaLabel) control.ariaLabel = clean(ariaLabel, LABEL_CAP);
		const title = element.getAttribute("title");
		if (title) control.title = clean(title, LABEL_CAP);
		const name = element.getAttribute("name");
		if (name) control.name = clean(name, LABEL_CAP);
		controls.push(control);
	}

	const words = [];
	const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
	const range = document.createRange();
	let node;
	let length = 0;
	while ((node = walker.nextNode()) && length < TEXT_CAP) {
		const value = (node.textContent || "").replace(/\s+/g, " ").trim();
		if (!value) continue;
		const parent = node.parentElement;
		if (!parent || !visible(parent)) continue;
		range.selectNodeContents(node);
		const box = range.getBoundingClientRect();
		if (box.width < 1 || box.height < 1) continue;
		words.push(value);
		length += value.length + 1;
	}

	// Widgets this loop cannot drive. Reported so the main model gets the page
	// back instead of a guess.
	const unsupported = [];
	if (document.querySelector("canvas")) unsupported.push("canvas");
	if (document.querySelector('input[type="file"]')) unsupported.push("file-upload");
	if (document.querySelector("iframe,frame")) unsupported.push("iframe");
	const scanned = document.querySelectorAll("*");
	for (let i = 0; i < scanned.length && i < 2000; i++) {
		if (scanned[i].shadowRoot) {
			unsupported.push("shadow-root");
			break;
		}
	}

	const guards = {};
	for (const control of controls) guards[control.node] = guard(cache.nodes.get(control.node));
	const scrollHeight = document.documentElement.scrollHeight;
	return {
		url: location.href,
		title: document.title,
		text: words.join("\n").slice(0, TEXT_CAP),
		viewport: { width: innerWidth, height: innerHeight },
		scroll: { x: Math.round(scrollX), y: Math.round(scrollY), height: Math.round(scrollHeight) },
		scrollable: {
			down: scrollY + innerHeight < scrollHeight - 2,
			up: scrollY > 0,
		},
		controls,
		guards,
		documentKey: documentKey(),
		hiddenControls: hidden,
		omittedControls: Math.max(0, matched - hidden - controls.length),
		readyState: document.readyState,
		unsupported,
	};
})()
