// @ts-check
(function () {
	const vscode = acquireVsCodeApi();
	const errorEl = /** @type {HTMLElement} */ (document.getElementById('error'));
	const rootEl = /** @type {HTMLElement} */ (document.getElementById('message-root'));
	const viewOnlyToggle = /** @type {HTMLButtonElement} */ (document.getElementById('view-only-toggle'));
	const diffToggle = /** @type {HTMLButtonElement} */ (document.getElementById('diff-toggle'));
	const diffOptionsEl = /** @type {HTMLElement} */ (document.getElementById('diff-options'));
	const diffSourceBtns = /** @type {NodeListOf<HTMLButtonElement>} */ (diffOptionsEl.querySelectorAll('.diff-source-btn'));
	const diffHighlightToggle = /** @type {HTMLButtonElement} */ (document.getElementById('diff-highlight-toggle'));
	const originalPaneEl = /** @type {HTMLElement} */ (document.getElementById('original-pane'));
	const originalRootEl = /** @type {HTMLElement} */ (document.getElementById('original-root'));
	const originalErrorEl = /** @type {HTMLElement} */ (document.getElementById('original-error'));
	const currentPaneLabelEl = /** @type {HTMLElement} */ (document.getElementById('current-pane-label'));

	/** @type {any} */
	let model = null;
	let lastSentText = null;
	/** @type {ReturnType<typeof setTimeout> | undefined} */
	let writeDebounceTimer;
	let viewOnly = false;

	let diffEnabled = false;
	let diffSource = 'save'; // 'commit' | 'save'
	let diffHighlightEnabled = false;
	let gitRepoAvailable = false;
	/** @type {Record<string, {text?: string, error?: string} | null>} */
	const originalCache = { save: null, commit: null };
	/** @type {any} */
	let originalModel = null;

	function saveState(/** @type {object} */ partial) {
		vscode.setState(Object.assign({}, vscode.getState(), partial));
	}

	window.addEventListener('message', (event) => {
		const msg = event.data;
		if (msg && msg.type === 'update') {
			saveState({ text: msg.text });
			if (msg.text === lastSentText) {
				// Echo of our own write round-tripping through the document;
				// our model/DOM are already correct, so skip re-rendering
				// (avoids stealing focus from whatever's being edited).
				return;
			}
			render(msg.text);
		} else if (msg && msg.type === 'empty') {
			saveState({ text: null });
			model = null;
			renderPlaceholder();
		} else if (msg && msg.type === 'gitStatus') {
			// gitStatus is (re-)sent exactly once per tracked document (initial
			// track or switching files) - use it as the signal that any cached
			// "last commit" content is for the wrong file now and must be
			// re-fetched rather than shown stale.
			originalCache.commit = null;
			gitRepoAvailable = !!msg.isRepo;
			if (!gitRepoAvailable && diffSource === 'commit') {
				diffSource = 'save';
				saveState({ diffSource });
			}
			if (diffEnabled) {
				if (diffSource === 'commit' && gitRepoAvailable) {
					requestOriginal('commit');
				}
				renderOriginal();
			}
			updateDiffSourceAvailability();
		} else if (msg && msg.type === 'originalContent') {
			if (msg.source === 'save' || msg.source === 'commit') {
				originalCache[msg.source] = { text: msg.text, error: msg.error };
				if (diffEnabled && diffSource === msg.source) {
					renderOriginal();
				}
			}
		}
	});

	const prevState = vscode.getState();
	viewOnly = !!(prevState && prevState.viewOnly);
	diffEnabled = !!(prevState && prevState.diffEnabled);
	diffSource = (prevState && prevState.diffSource) || 'save';
	diffHighlightEnabled = !!(prevState && prevState.diffHighlightEnabled);
	if (prevState && prevState.text) {
		render(prevState.text);
	} else if (prevState) {
		renderPlaceholder();
	}
	applyViewOnlyState();
	applyDiffState();

	viewOnlyToggle.addEventListener('click', () => {
		// Commit whatever's mid-edit before hiding the controls that would
		// otherwise let you keep editing it.
		const active = document.activeElement;
		if (active instanceof HTMLElement && rootEl.contains(active)) {
			active.blur();
		}
		viewOnly = !viewOnly;
		saveState({ viewOnly });
		applyViewOnlyState();
	});

	diffToggle.addEventListener('click', () => {
		diffEnabled = !diffEnabled;
		saveState({ diffEnabled });
		applyDiffState();
	});

	diffSourceBtns.forEach((btn) => {
		btn.addEventListener('click', () => {
			if (btn.disabled || btn.dataset.source === diffSource) {
				return;
			}
			diffSource = /** @type {string} */ (btn.dataset.source);
			saveState({ diffSource });
			applyDiffState();
		});
	});

	diffHighlightToggle.addEventListener('click', () => {
		diffHighlightEnabled = !diffHighlightEnabled;
		saveState({ diffHighlightEnabled });
		applyDiffHighlightToggleState();
		applyDiffHighlight();
	});

	function applyViewOnlyState() {
		document.body.classList.toggle('view-only', viewOnly);
		viewOnlyToggle.classList.toggle('active', viewOnly);
		viewOnlyToggle.textContent = viewOnly ? 'Exit view only' : 'View only';
		rootEl.querySelectorAll('.editable').forEach((el) => {
			el.setAttribute('contenteditable', viewOnly ? 'false' : 'true');
		});
	}

	function applyDiffState() {
		diffToggle.classList.toggle('active', diffEnabled);
		diffToggle.textContent = diffEnabled ? 'Exit diff view' : 'Diff view';
		diffOptionsEl.hidden = !diffEnabled;
		originalPaneEl.hidden = !diffEnabled;
		currentPaneLabelEl.hidden = !diffEnabled;
		updateDiffSourceAvailability();
		applyDiffHighlightToggleState();
		if (diffEnabled) {
			requestOriginal(diffSource);
			renderOriginal();
		} else {
			applyDiffHighlight();
		}
	}

	function applyDiffHighlightToggleState() {
		diffHighlightToggle.classList.toggle('active', diffHighlightEnabled);
	}

	// ---- diff highlighting ----
	//
	// Two embeds/fields at the same array index aren't necessarily "the same
	// slot" - removing one field shifts every later field's index, which would
	// otherwise make them all look modified. alignArrays() fixes that with a
	// two-pass match against the *other* model's list:
	//   1. exact (deep-equal) matches, found via LCS - these are untouched
	//      items and anchor the alignment regardless of any shift around them.
	//   2. within the gaps between anchors, a looser identity check (field
	//      name / embed title) pairs up "same slot, edited" items as
	//      'modified' so their contents get a word-level diff instead of a
	//      wholesale remove+add.
	// Anything left over after both passes is a genuine whole-item add/remove.
	function applyDiffHighlight() {
		clearDiffHighlights();

		if (!diffEnabled || !diffHighlightEnabled || !model || !originalModel) {
			return;
		}

		const currentPaths = getDiffPathMap(rootEl);
		const originalPaths = getDiffPathMap(originalRootEl);

		diffLeafText('message.username', 'message.username', currentPaths, originalPaths);
		diffLeafText('message.content', 'message.content', currentPaths, originalPaths);

		const embedOps = alignArrays(originalModel.embeds || [], model.embeds || [], deepEqual, embedIdentity);
		embedOps.forEach((op) => {
			if (op.type === 'removed') {
				markDiffUnit(originalRootEl, `embed.${op.oldIndex}`, 'diff-unit-removed');
				return;
			}
			if (op.type === 'added') {
				markDiffUnit(rootEl, `embed.${op.newIndex}`, 'diff-unit-added');
				return;
			}
			if (op.type !== 'modified') {
				return; // 'equal': untouched, nothing to highlight
			}

			const oldI = op.oldIndex;
			const newI = op.newIndex;
			diffLeafText(`embed.${oldI}.title`, `embed.${newI}.title`, currentPaths, originalPaths);
			diffLeafText(`embed.${oldI}.description`, `embed.${newI}.description`, currentPaths, originalPaths);
			diffLeafText(`embed.${oldI}.author.name`, `embed.${newI}.author.name`, currentPaths, originalPaths);
			diffLeafText(`embed.${oldI}.footer.text`, `embed.${newI}.footer.text`, currentPaths, originalPaths);

			const oldFields = (originalModel.embeds[oldI] && originalModel.embeds[oldI].fields) || [];
			const newFields = (model.embeds[newI] && model.embeds[newI].fields) || [];
			const fieldOps = alignArrays(oldFields, newFields, deepEqual, fieldIdentity);
			fieldOps.forEach((fop) => {
				if (fop.type === 'removed') {
					markDiffUnit(originalRootEl, `embed.${oldI}.field.${fop.oldIndex}`, 'diff-unit-removed');
				} else if (fop.type === 'added') {
					markDiffUnit(rootEl, `embed.${newI}.field.${fop.newIndex}`, 'diff-unit-added');
				} else if (fop.type === 'modified') {
					diffLeafText(`embed.${oldI}.field.${fop.oldIndex}.name`, `embed.${newI}.field.${fop.newIndex}.name`, currentPaths, originalPaths);
					diffLeafText(`embed.${oldI}.field.${fop.oldIndex}.value`, `embed.${newI}.field.${fop.newIndex}.value`, currentPaths, originalPaths);
				}
			});
		});
	}

	// Undoes both kinds of mutation applyDiffHighlight() makes - the
	// word-diffed innerHTML of leaf pieces and the whole-unit background
	// classes - so re-running it from scratch never leaves stale markup from
	// a previous model state behind (e.g. a field that used to be "modified"
	// but is now identical again).
	function clearDiffHighlights() {
		resetLeafPieces(rootEl, model);
		resetLeafPieces(originalRootEl, originalModel);
		rootEl.querySelectorAll('.diff-unit-added').forEach((el) => el.classList.remove('diff-unit-added'));
		originalRootEl.querySelectorAll('.diff-unit-removed').forEach((el) => el.classList.remove('diff-unit-removed'));
	}

	function resetLeafPieces(/** @type {HTMLElement} */ container, ownerModel) {
		if (!ownerModel) {
			return;
		}
		container.querySelectorAll('[data-diff-path]').forEach((el) => {
			const piece = /** @type {HTMLElement} */ (el);
			if (piece.dataset.editing === '1') {
				return; // don't clobber an in-progress edit
			}
			const raw = getRaw(ownerModel, piece.dataset.diffPath) || '';
			renderEditablePieceInPlace(piece, raw);
		});
	}

	function getDiffPathMap(/** @type {HTMLElement} */ container) {
		const map = new Map();
		container.querySelectorAll('[data-diff-path]').forEach((el) => {
			map.set(/** @type {HTMLElement} */ (el).dataset.diffPath, el);
		});
		return map;
	}

	function markDiffUnit(/** @type {HTMLElement} */ container, /** @type {string} */ unitPath, /** @type {string} */ cssClass) {
		const el = container.querySelector(`[data-diff-unit="${unitPath}"]`);
		if (el) {
			el.classList.add(cssClass);
		}
	}

	// Renders a word-level diff of the value at a path into whichever side(s)
	// actually have it: oldPath only exists while there's original text to
	// mark red, newPath only while there's current text to mark green. A
	// value that only exists on one side (pure add/remove of a still-existing
	// field's text) degenerates naturally to "every token is a diff" on that
	// side, so no separate case is needed for it.
	function diffLeafText(oldPath, newPath, currentPaths, originalPaths) {
		const oldRaw = getRaw(originalModel, oldPath) || '';
		const newRaw = getRaw(model, newPath) || '';
		if (oldRaw === newRaw) {
			return;
		}
		const ops = diffTokens(tokenize(oldRaw), tokenize(newRaw));
		if (oldRaw) {
			const oldEl = originalPaths.get(oldPath);
			if (oldEl && oldEl.dataset.editing !== '1') {
				oldEl.innerHTML = renderDiffedInner(oldEl.dataset.mode, ops, 'old', oldEl.dataset.linkUrl);
			}
		}
		if (newRaw) {
			const newEl = currentPaths.get(newPath);
			if (newEl && newEl.dataset.editing !== '1') {
				newEl.innerHTML = renderDiffedInner(newEl.dataset.mode, ops, 'new', newEl.dataset.linkUrl);
			}
		}
	}

	// Private-use-area characters (invisible, and can't collide with text a
	// user actually typed): pass untouched through escapeHtml() and every
	// markdown regex below, then get swapped for real <span> tags once
	// rendering is done.
	const DIFF_OPEN = '';
	const DIFF_CLOSE = '';

	// Visible marker for a newline that begins or ends a diff run - see
	// markDiffNewlines().
	const NEWLINE_MARKER = '⏎';

	// Reconstructs one side's text with DIFF_OPEN/DIFF_CLOSE bracketing the
	// runs relevant to that side (removals for 'old', additions for 'new'),
	// then renders it through the exact same plain/markdown pipeline normal
	// pieces use, and only afterwards swaps the sentinels for real <span>
	// tags. Diffing before markdown rendering (rather than diffing the
	// rendered HTML) keeps **bold**/*italic*/etc. syntax intact instead of
	// tokenizing it away.
	function renderDiffedInner(mode, ops, /** @type {'old'|'new'} */ side, linkUrl) {
		const relevant = side === 'old' ? 'remove' : 'add';
		let marked = '';
		let open = false;
		ops.forEach((op) => {
			if (op.type === 'equal') {
				if (open) {
					marked += DIFF_CLOSE;
					open = false;
				}
				marked += op.text;
			} else if (op.type === relevant) {
				if (!open) {
					marked += DIFF_OPEN;
					open = true;
				}
				marked += op.text;
			}
		});
		if (open) {
			marked += DIFF_CLOSE;
		}
		marked = markDiffNewlines(marked);
		const html = renderRawInner(mode, marked, linkUrl);
		const spanClass = side === 'old' ? 'diff-word-removed' : 'diff-word-added';
		return html.split(DIFF_OPEN).join(`<span class="${spanClass}">`).split(DIFF_CLOSE).join('</span>');
	}

	// A newline that begins or ends a diff run has no visible width of its
	// own - the line just breaks the same as any unchanged line break would,
	// so an added/removed blank line (or line-break-plus-word) can look like
	// only the neighboring word changed. Stamping a return glyph right at
	// that boundary (still followed by the real "\n", so the line still
	// wraps where it always did) makes the line break itself visibly part of
	// what changed.
	function markDiffNewlines(/** @type {string} */ text) {
		return text.replace(/\n/g, (match, offset, str) => {
			const before = str.slice(offset - DIFF_OPEN.length, offset);
			const after = str.slice(offset + 1, offset + 1 + DIFF_CLOSE.length);
			return before === DIFF_OPEN || after === DIFF_CLOSE ? NEWLINE_MARKER + match : match;
		});
	}

	// Splits on runs of whitespace so a "word" diff doesn't get thrown off by
	// incidental spacing changes, while still keeping the spacing itself as
	// its own token so it round-trips exactly when nothing changed around it.
	function tokenize(/** @type {string} */ text) {
		return text.split(/(\s+)/).filter((t) => t.length > 0);
	}

	// Classic LCS-backed diff, same shape as alignArrays()'s anchor pass but
	// over word tokens instead of list items - see the block comment above
	// applyDiffHighlight() for the general idea.
	function diffTokens(oldTokens, newTokens) {
		const n = oldTokens.length;
		const m = newTokens.length;
		const dp = [];
		for (let i = 0; i <= n; i++) {
			dp.push(new Array(m + 1).fill(0));
		}
		for (let i = n - 1; i >= 0; i--) {
			for (let j = m - 1; j >= 0; j--) {
				dp[i][j] = oldTokens[i] === newTokens[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
			}
		}
		const ops = [];
		let i = 0;
		let j = 0;
		while (i < n && j < m) {
			if (oldTokens[i] === newTokens[j]) {
				ops.push({ type: 'equal', text: oldTokens[i] });
				i++;
				j++;
			} else if (dp[i + 1][j] >= dp[i][j + 1]) {
				ops.push({ type: 'remove', text: oldTokens[i] });
				i++;
			} else {
				ops.push({ type: 'add', text: newTokens[j] });
				j++;
			}
		}
		while (i < n) {
			ops.push({ type: 'remove', text: oldTokens[i] });
			i++;
		}
		while (j < m) {
			ops.push({ type: 'add', text: newTokens[j] });
			j++;
		}
		return ops;
	}

	// Aligns two lists (embeds, or the fields within one embed) into ops:
	// 'equal' (untouched anchor), 'modified' (same slot, different content),
	// 'removed' (old-only), 'added' (new-only). See the block comment above
	// applyDiffHighlight() for why this two-pass approach is needed instead
	// of a plain index-by-index comparison.
	function alignArrays(oldList, newList, deepEqualFn, identityFn) {
		const anchors = lcsAnchors(oldList, newList, deepEqualFn);
		const ops = [];

		function pairGap(oldStart, oldEnd, newStart, newEnd) {
			const oldSeg = [];
			for (let i = oldStart; i < oldEnd; i++) {
				oldSeg.push(i);
			}
			const newSeg = [];
			for (let j = newStart; j < newEnd; j++) {
				newSeg.push(j);
			}
			const usedNew = new Set();
			const matchedOld = new Set();
			oldSeg.forEach((oi) => {
				const match = newSeg.find((nj) => !usedNew.has(nj) && identityFn(oldList[oi], newList[nj]));
				if (match !== undefined) {
					usedNew.add(match);
					matchedOld.add(oi);
					ops.push({ type: 'modified', oldIndex: oi, newIndex: match });
				}
			});
			const leftoverOld = oldSeg.filter((oi) => !matchedOld.has(oi));
			const leftoverNew = newSeg.filter((nj) => !usedNew.has(nj));
			// identityFn can't help here (e.g. a title edit changes the very
			// thing embedIdentity() keys on) - but if exactly one item is left
			// unmatched on each side, there's no ambiguity about which pairs
			// with which, so treat it as that same slot edited in place rather
			// than a wholesale remove+add. With 2+ left on either side, which
			// old item corresponds to which new one is a genuine guess, so
			// don't - list them as separate removes/adds instead of risking a
			// misleading pairing.
			if (leftoverOld.length === 1 && leftoverNew.length === 1) {
				ops.push({ type: 'modified', oldIndex: leftoverOld[0], newIndex: leftoverNew[0] });
				return;
			}
			leftoverOld.forEach((oi) => ops.push({ type: 'removed', oldIndex: oi }));
			leftoverNew.forEach((nj) => ops.push({ type: 'added', newIndex: nj }));
		}

		let oldPos = 0;
		let newPos = 0;
		anchors.forEach(({ oldIndex, newIndex }) => {
			pairGap(oldPos, oldIndex, newPos, newIndex);
			ops.push({ type: 'equal', oldIndex, newIndex });
			oldPos = oldIndex + 1;
			newPos = newIndex + 1;
		});
		pairGap(oldPos, oldList.length, newPos, newList.length);

		return ops;
	}

	function lcsAnchors(oldList, newList, equalFn) {
		const n = oldList.length;
		const m = newList.length;
		const dp = [];
		for (let i = 0; i <= n; i++) {
			dp.push(new Array(m + 1).fill(0));
		}
		for (let i = n - 1; i >= 0; i--) {
			for (let j = m - 1; j >= 0; j--) {
				dp[i][j] = equalFn(oldList[i], newList[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
			}
		}
		const anchors = [];
		let i = 0;
		let j = 0;
		while (i < n && j < m) {
			if (equalFn(oldList[i], newList[j])) {
				anchors.push({ oldIndex: i, newIndex: j });
				i++;
				j++;
			} else if (dp[i + 1][j] >= dp[i][j + 1]) {
				i++;
			} else {
				j++;
			}
		}
		return anchors;
	}

	function embedIdentity(a, b) {
		const at = a && typeof a.title === 'string' ? a.title : '';
		const bt = b && typeof b.title === 'string' ? b.title : '';
		return !!at && at === bt;
	}

	function fieldIdentity(a, b) {
		const an = a && typeof a.name === 'string' ? a.name : '';
		const bn = b && typeof b.name === 'string' ? b.name : '';
		return !!an && an === bn;
	}

	function deepEqual(a, b) {
		if (a === b) {
			return true;
		}
		if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
			return false;
		}
		if (Array.isArray(a) !== Array.isArray(b)) {
			return false;
		}
		if (Array.isArray(a)) {
			return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
		}
		const aKeys = Object.keys(a);
		const bKeys = Object.keys(b);
		return aKeys.length === bKeys.length && aKeys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
	}

	function updateDiffSourceAvailability() {
		diffSourceBtns.forEach((btn) => {
			const isCommit = btn.dataset.source === 'commit';
			btn.classList.toggle('active', btn.dataset.source === diffSource);
			btn.disabled = isCommit && !gitRepoAvailable;
			btn.title = isCommit && !gitRepoAvailable ? 'Not a git repository' : '';
		});
	}

	function requestOriginal(/** @type {string} */ source) {
		vscode.postMessage({ type: 'requestOriginal', source });
	}

	function renderOriginal() {
		originalModel = null;
		const entry = originalCache[diffSource];
		if (!entry) {
			hideOriginalError();
			originalRootEl.innerHTML = buildLoadingHtml(diffSource);
			applyDiffHighlight();
			return;
		}
		if (entry.error) {
			showOriginalError(entry.error);
			originalRootEl.innerHTML = '';
			applyDiffHighlight();
			return;
		}
		if (!entry.text || !entry.text.trim()) {
			showOriginalError('Empty file.');
			originalRootEl.innerHTML = '';
			applyDiffHighlight();
			return;
		}
		let parsed;
		try {
			parsed = JSON.parse(entry.text);
		} catch (e) {
			showOriginalError('Invalid JSON: ' + e.message);
			originalRootEl.innerHTML = '';
			applyDiffHighlight();
			return;
		}
		let normalized;
		try {
			normalized = normalize(parsed);
		} catch (e) {
			showOriginalError(e.message);
			originalRootEl.innerHTML = '';
			applyDiffHighlight();
			return;
		}
		hideOriginalError();
		originalModel = normalized;
		originalRootEl.innerHTML = buildRootHtml(normalized, true);
		applyDiffHighlight();
	}

	function buildLoadingHtml(/** @type {string} */ source) {
		const label = source === 'commit' ? 'Fetching last commit embed…' : 'Loading last saved embed…';
		return `<div class="loading-state"><span class="spinner"></span>${escapeHtml(label)}</div>`;
	}

	function showOriginalError(/** @type {string} */ text) {
		originalErrorEl.textContent = text;
		originalErrorEl.hidden = false;
	}

	function hideOriginalError() {
		originalErrorEl.hidden = true;
	}

	rootEl.addEventListener('focusin', onFocusIn);
	rootEl.addEventListener('focusout', onFocusOut);
	rootEl.addEventListener('keydown', onKeyDown);
	rootEl.addEventListener('paste', onPaste);
	rootEl.addEventListener('click', onClick);

	function renderPlaceholder() {
		hideError();
		rootEl.innerHTML = '<div class="placeholder">Open a JSON file to preview.</div>';
	}

	function render(rawText) {
		if (!rawText || !rawText.trim()) {
			model = null;
			showError('Empty file.');
			return;
		}
		let parsed;
		try {
			parsed = JSON.parse(rawText);
		} catch (e) {
			showError('Invalid JSON: ' + e.message);
			return;
		}

		let normalized;
		try {
			normalized = normalize(parsed);
		} catch (e) {
			showError(e.message);
			return;
		}

		hideError();
		model = normalized;
		rootEl.innerHTML = buildRootHtml(model, false);
		applyViewOnlyState();
		applyDiffHighlight();
	}

	function showError(text) {
		errorEl.textContent = text;
		errorEl.hidden = false;
	}

	function hideError() {
		errorEl.hidden = true;
	}

	const EMBED_KEYS = ['title', 'description', 'color', 'fields', 'image', 'thumbnail', 'footer', 'author', 'url', 'timestamp', 'video', 'provider'];

	function looksLikeEmbed(obj) {
		return EMBED_KEYS.some((k) => k in obj);
	}

	// model.shape records which JSON shape the file originally used, so
	// serialize() can write back the same shape instead of always emitting
	// a canonical form.
	function normalize(parsed) {
		if (Array.isArray(parsed)) {
			return { shape: 'array', message: null, embeds: parsed };
		}
		if (parsed && typeof parsed === 'object') {
			if (Array.isArray(parsed.embeds)) {
				return { shape: 'message', message: parsed, embeds: parsed.embeds };
			}
			if (looksLikeEmbed(parsed)) {
				return { shape: 'singleEmbed', message: null, embeds: [parsed] };
			}
			if (typeof parsed.content === 'string') {
				return { shape: 'message', message: parsed, embeds: [] };
			}
		}
		throw new Error(
			'Unrecognized JSON shape. Expected a Discord message object ({ content, embeds }), a bare embed array, or a single embed object.'
		);
	}

	function serialize(m) {
		if (m.shape === 'array') {
			return JSON.stringify(m.embeds, null, 2);
		}
		if (m.shape === 'singleEmbed') {
			return JSON.stringify(m.embeds[0] || {}, null, 2);
		}
		return JSON.stringify(Object.assign({}, m.message, { embeds: m.embeds }), null, 2);
	}

	// A 'singleEmbed'-shaped file can only represent exactly one embed; once
	// add/remove makes that untrue, it has to be written back as an array.
	function upgradeShapeIfNeeded() {
		if (model.shape === 'singleEmbed' && model.embeds.length !== 1) {
			model.shape = 'array';
		}
	}

	// Path vocabulary: "message.<key>", "embed.<i>.<key>", "embed.<i>.author.<key>",
	// "embed.<i>.footer.<key>", "embed.<i>.field.<j>.<key>".
	function getRaw(m, path) {
		const parts = path.split('.');
		if (parts[0] === 'message') {
			return m.message ? m.message[parts[1]] : undefined;
		}
		if (parts[0] === 'embed') {
			const embed = m.embeds[Number(parts[1])];
			if (!embed) {
				return undefined;
			}
			if (parts[2] === 'field') {
				const field = embed.fields && embed.fields[Number(parts[3])];
				return field ? field[parts[4]] : undefined;
			}
			if (parts[2] === 'author' || parts[2] === 'footer') {
				return embed[parts[2]] ? embed[parts[2]][parts[3]] : undefined;
			}
			return embed[parts[2]];
		}
		return undefined;
	}

	function setRaw(m, path, value) {
		const parts = path.split('.');
		if (parts[0] === 'message') {
			if (m.message) {
				m.message[parts[1]] = value;
			}
			return;
		}
		if (parts[0] === 'embed') {
			const embed = m.embeds[Number(parts[1])];
			if (!embed) {
				return;
			}
			if (parts[2] === 'field') {
				const field = embed.fields && embed.fields[Number(parts[3])];
				if (field) {
					field[parts[4]] = value;
				}
				return;
			}
			if (parts[2] === 'author' || parts[2] === 'footer') {
				const isEmpty = typeof value === 'string' && value.length === 0;
				if (!embed[parts[2]] && isEmpty) {
					return; // don't create an author/footer object just for an untouched placeholder
				}
				if (!embed[parts[2]]) {
					embed[parts[2]] = {};
				}
				embed[parts[2]][parts[3]] = value;
				return;
			}
			embed[parts[2]] = value;
		}
	}

	function scheduleWrite() {
		if (writeDebounceTimer) {
			clearTimeout(writeDebounceTimer);
		}
		writeDebounceTimer = setTimeout(() => {
			if (!model) {
				return;
			}
			const text = serialize(model);
			lastSentText = text;
			vscode.postMessage({ type: 'write', text });
		}, 300);
	}

	function rerenderAndSchedule() {
		rootEl.innerHTML = buildRootHtml(model, false);
		applyViewOnlyState();
		applyDiffHighlight();
		scheduleWrite();
	}

	// ---- editable text pieces (click-to-edit raw markdown / blur-to-render) ----

	function editablePiece(path, rawValue, opts) {
		const mode = opts.mode || 'plain'; // 'plain' | 'md' | 'md-heading'
		const placeholder = opts.placeholder || '';
		const tag = opts.tag || 'div';
		const cls = 'editable' + (opts.className ? ' ' + opts.className : '');
		const raw = typeof rawValue === 'string' ? rawValue : '';
		const inner = renderPieceInner(mode, raw, placeholder, opts.linkUrl);

		const linkUrlAttr = opts.linkUrl ? ` data-link-url="${escapeAttr(opts.linkUrl)}"` : '';

		if (opts.readOnly) {
			// No data-bind/contenteditable/tabindex: this rendering is never
			// wired to the edit event handlers (those only listen on the
			// editable "current" pane), so it must not look or behave editable.
			// data-diff-path/data-placeholder/data-link-url are still included
			// so the diff-highlight pass (which only reads, never edits) can
			// pair this element up with its counterpart in the other pane and
			// re-render it (clean or word-diffed) the same way it would the
			// editable version.
			return `<${tag} class="${cls}" data-mode="${mode}" data-diff-path="${escapeAttr(path)}" data-placeholder="${escapeAttr(placeholder)}"${linkUrlAttr}>${inner}</${tag}>`;
		}

		const multiline = opts.multiline ? ' data-multiline="1"' : '';
		return `<${tag} class="${cls}" data-bind="${escapeAttr(path)}" data-diff-path="${escapeAttr(path)}" data-mode="${mode}" data-placeholder="${escapeAttr(placeholder)}"${multiline}${linkUrlAttr} contenteditable="true" tabindex="0">${inner}</${tag}>`;
	}

	function renderRawInner(mode, raw, linkUrl) {
		if (mode === 'plain') {
			return linkUrl ? `<a href="${escapeAttr(linkUrl)}" target="_blank" rel="noreferrer">${escapeHtml(raw)}</a>` : escapeHtml(raw);
		}
		return renderMarkdown(raw, { allowHeadings: mode === 'md-heading' });
	}

	function renderPieceInner(mode, raw, placeholder, linkUrl) {
		if (!raw) {
			return `<span class="placeholder-text">${escapeHtml(placeholder)}</span>`;
		}
		return renderRawInner(mode, raw, linkUrl);
	}

	function renderEditablePieceInPlace(el, raw) {
		const mode = el.dataset.mode;
		const placeholder = el.dataset.placeholder || '';
		el.innerHTML = renderPieceInner(mode, raw, placeholder, el.dataset.linkUrl);
	}

	function targetClosest(/** @type {Event} */ e, /** @type {string} */ selector) {
		const target = /** @type {HTMLElement} */ (e.target);
		return /** @type {HTMLElement | null} */ (target && target.closest ? target.closest(selector) : null);
	}

	// Multiline pieces (description/content/field value) swap in a real
	// <textarea> while focused instead of relying on contenteditable's
	// Enter-key semantics, which are ambiguous across browsers (can silently
	// drop the newline entirely, or need an extra keypress before it "takes").
	// A textarea's newline handling is unambiguous and needs no special-casing.
	function onFocusIn(e) {
		const el = targetClosest(e, '.editable');
		if (!el || el.dataset.editing === '1') {
			return;
		}
		if (viewOnly) {
			// contenteditable="false" blocks native typing, but the element is
			// still tabindex="0" so it can still be focused (click or Tab) and
			// fire focusin - refuse to enter edit mode (that's what actually
			// created the nested <textarea> for multiline fields regardless of
			// contenteditable) and give focus back up immediately.
			el.blur();
			return;
		}
		el.dataset.editing = '1';
		const raw = getRaw(model, el.dataset.bind) || '';

		if (el.dataset.multiline === '1') {
			// Deliberately not toggling the wrapper's contenteditable attribute:
			// changing it on an element that currently has focus can trigger an
			// immediate synchronous blur in some browsers, re-entering
			// onFocusOut before the textarea even exists below. A <textarea>
			// manages its own editing state independently of an ancestor's
			// contenteditable, so there's no need to touch it at all.
			const textarea = document.createElement('textarea');
			textarea.className = 'editable-textarea';
			textarea.value = raw;

			// A <textarea> is a block-level replaced element, so unlike wrapped
			// text it can't narrow itself to share a line with a float - a
			// width:100% box that doesn't fit beside the float just gets pushed
			// below it entirely, leaving a gap where the float still is. Only
			// the description sits beside the (floated) thumbnail, so only it
			// needs to match the narrower width available there. Fields live
			// in .embed-fields, which is `clear: both` (already below the
			// float) - narrowing them too was leaving a wide dead gap in
			// already-narrow inline fields.
			const isDescription = el.classList.contains('embed-description');
			const embedText = isDescription && el.closest('.embed-text');
			const hasThumbnail = embedText && embedText.querySelector(':scope > .embed-thumbnail');
			textarea.style.width = hasThumbnail ? 'calc(100% - 88px)' : '100%';

			el.innerHTML = '';
			el.appendChild(textarea);
			autosizeTextarea(textarea);
			textarea.addEventListener('input', () => autosizeTextarea(textarea));
			textarea.focus();
			textarea.setSelectionRange(textarea.value.length, textarea.value.length);
		} else {
			el.textContent = raw;
		}
	}

	function autosizeTextarea(/** @type {HTMLTextAreaElement} */ textarea) {
		textarea.style.height = 'auto';
		textarea.style.height = textarea.scrollHeight + 'px';
	}

	function onFocusOut(e) {
		const el = targetClosest(e, '.editable');
		if (!el) {
			return;
		}
		if (viewOnly) {
			// onFocusIn's el.blur() for view-only fires this handler
			// synchronously, reentrantly, before it returns. Since view-only
			// never entered edit mode (no textarea created, no raw textContent
			// swapped in), reading "the current value" here would see empty
			// content and write that back over the real value - bail instead.
			return;
		}
		// Moving focus from the wrapper into its own nested <textarea> (see
		// onFocusIn) fires focusout on the wrapper too - that's not a real
		// blur, the field is still being edited, so don't tear it down.
		const relatedTarget = /** @type {Node | null} */ (e.relatedTarget);
		if (relatedTarget && el.contains(relatedTarget)) {
			return;
		}
		delete el.dataset.editing;
		const path = el.dataset.bind;
		let raw;
		if (el.dataset.multiline === '1') {
			const textarea = /** @type {HTMLTextAreaElement | null} */ (el.querySelector('textarea.editable-textarea'));
			raw = textarea ? textarea.value : '';
		} else {
			raw = el.textContent || '';
		}
		setRaw(model, path, raw);
		renderEditablePieceInPlace(el, raw);
		applyDiffHighlight();
		scheduleWrite();
	}

	// Deliberately not execCommand('insertText', ...) for single-line paste:
	// in a contenteditable region Chromium treats that as rich-text input,
	// which can reintroduce formatting we don't want. Inserting a plain Text
	// node via the Range API guarantees plain text lands exactly as pasted.
	function insertPlainText(/** @type {string} */ text) {
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0) {
			return;
		}
		const range = sel.getRangeAt(0);
		range.deleteContents();
		const textNode = document.createTextNode(text);
		range.insertNode(textNode);
		range.setStartAfter(textNode);
		range.setEndAfter(textNode);
		sel.removeAllRanges();
		sel.addRange(range);
	}

	function onKeyDown(/** @type {KeyboardEvent} */ e) {
		const el = targetClosest(e, '.editable');
		if (!el || viewOnly || e.key !== 'Enter' || el.dataset.multiline === '1') {
			return; // multiline: let the native textarea handle Enter itself
		}
		e.preventDefault();
		el.blur();
	}

	function onPaste(/** @type {ClipboardEvent} */ e) {
		const el = targetClosest(e, '.editable');
		if (!el || viewOnly || el.dataset.multiline === '1') {
			return; // textarea paste is already plain-text only, natively
		}
		e.preventDefault();
		const text = (e.clipboardData || window.clipboardData).getData('text/plain');
		insertPlainText(text);
	}

	// ---- structural controls (add/remove/toggle fields & embeds) ----

	function onClick(e) {
		const btn = targetClosest(e, '[data-action]');
		if (!btn || !model) {
			return;
		}
		const action = btn.dataset.action;
		const embedIndex = btn.dataset.embedIndex !== undefined && btn.dataset.embedIndex !== '' ? Number(btn.dataset.embedIndex) : undefined;
		const fieldIndex = btn.dataset.fieldIndex !== undefined ? Number(btn.dataset.fieldIndex) : undefined;
		const insertAt = btn.dataset.insertAt !== undefined ? Number(btn.dataset.insertAt) : undefined;

		if (action === 'toggle-inline') {
			const field = model.embeds[embedIndex].fields[fieldIndex];
			field.inline = !field.inline;
			rerenderAndSchedule();
		} else if (action === 'remove-field') {
			model.embeds[embedIndex].fields.splice(fieldIndex, 1);
			rerenderAndSchedule();
		} else if (action === 'add-field') {
			const embed = model.embeds[embedIndex];
			if (!Array.isArray(embed.fields)) {
				embed.fields = [];
			}
			const defaultInline = btn.dataset.defaultInline !== '0';
			embed.fields.splice(insertAt, 0, { name: 'Field', value: 'Value', inline: defaultInline });
			rerenderAndSchedule();
			focusNewField(embedIndex, insertAt);
		} else if (action === 'remove-embed') {
			model.embeds.splice(embedIndex, 1);
			upgradeShapeIfNeeded();
			rerenderAndSchedule();
		} else if (action === 'add-embed') {
			model.embeds.splice(insertAt, 0, { title: '', description: '', fields: [] });
			upgradeShapeIfNeeded();
			rerenderAndSchedule();
		}
	}

	function focusNewField(embedIndex, fieldIndex) {
		const el = rootEl.querySelector(`.editable[data-bind="embed.${embedIndex}.field.${fieldIndex}.name"]`);
		if (!el) {
			return;
		}
		el.focus();
		const range = document.createRange();
		range.selectNodeContents(el);
		const sel = window.getSelection();
		if (sel) {
			sel.removeAllRanges();
			sel.addRange(range);
		}
	}

	// Always-visible, full-width "insert a field/embed here" divider. Its
	// width matches what it creates: full-width buttons always default to a
	// non-inline field (only the small per-inline-field button defaults to
	// inline - see smallAddFieldButton).
	function insertZone(action, attrs, insertAt, /** @type {string} */ label, /** @type {boolean} */ defaultInline = false) {
		const attrStr = Object.keys(attrs)
			.map((k) => `data-${k}="${attrs[k]}"`)
			.join(' ');
		return `<button type="button" class="insert-zone" data-action="${action}" ${attrStr} data-insert-at="${insertAt}" data-default-inline="${defaultInline ? '1' : '0'}"><span class="h-sep"></span><span class="sq-btn">+</span><span class="insert-label">${escapeHtml(label)}</span><span class="h-sep"></span></button>`;
	}

	// Small always-visible "+" glued to the right of a single inline field,
	// for quickly adding another inline field beside it.
	function smallAddFieldButton(embedIndex, insertAt) {
		return `<button type="button" class="inline-add-btn" data-action="add-field" data-embed-index="${embedIndex}" data-insert-at="${insertAt}" data-default-inline="1" title="Add inline field"><span class="v-sep"></span><span class="sq-btn">+</span><span class="v-sep"></span></button>`;
	}

	// ---- HTML building ----
	// Every builder below takes a trailing `readOnly` flag used for the diff
	// view's "original" pane: when set, structural controls (add/remove/
	// toggle buttons) are omitted entirely and editablePiece() renders plain,
	// non-editable markup - that pane must never be interactive.

	function buildRootHtml(m, readOnly) {
		const embedsHtml = buildEmbedsListHtml(m.embeds, readOnly);

		if (!m.message) {
			return `<div class="embeds-only">${embedsHtml}</div>`;
		}

		const message = m.message;
		const avatarUrl = safeUrl(message.avatar_url);
		const avatarHtml = avatarUrl
			? `<img class="avatar" src="${escapeAttr(avatarUrl)}">`
			: `<div class="avatar"></div>`;
		const botTag = message.username || message.avatar_url ? '<span class="bot-tag">BOT</span>' : '';

		const usernameHtml = editablePiece('message.username', message.username, {
			mode: 'plain',
			placeholder: 'Bot',
			tag: 'span',
			className: 'username',
			readOnly
		});
		const contentHtml = editablePiece('message.content', message.content, {
			mode: 'md-heading',
			placeholder: 'Add message content…',
			tag: 'div',
			className: 'message-content',
			multiline: true,
			readOnly
		});

		return `
			<div class="discord-message">
				${avatarHtml}
				<div class="message-body">
					<div class="message-header">
						${usernameHtml}
						${botTag}
						<span class="timestamp">Today at 12:00 PM</span>
					</div>
					${contentHtml}
					${embedsHtml}
				</div>
			</div>`;
	}

	function buildEmbedsListHtml(embeds, readOnly) {
		const list = Array.isArray(embeds) ? embeds : [];
		let html = readOnly ? '' : insertZone('add-embed', {}, 0, 'Add embed');
		list.forEach((embed, i) => {
			html += buildEmbedHtml(embed, i, readOnly);
			if (!readOnly) {
				html += insertZone('add-embed', {}, i + 1, 'Add embed');
			}
		});
		return html;
	}

	function buildEmbedHtml(embed, embedIndex, readOnly) {
		if (!embed || typeof embed !== 'object') {
			embed = {};
		}

		const colorHex = typeof embed.color === 'number' ? intToHex(embed.color) : null;
		const colorBar = colorHex ? `<div class="embed-color-bar" style="background:${colorHex}"></div>` : '';

		const authorHtml = buildAuthorHtml(embedIndex, embed.author, readOnly);
		const titleHtml = editablePiece(`embed.${embedIndex}.title`, embed.title, {
			mode: 'plain',
			placeholder: 'Title',
			className: 'embed-title',
			linkUrl: safeUrl(embed.url),
			readOnly
		});
		const descriptionHtml = editablePiece(`embed.${embedIndex}.description`, embed.description, {
			mode: 'md-heading',
			placeholder: 'Add description…',
			className: 'embed-description',
			multiline: true,
			readOnly
		});
		const fieldsHtml = buildFieldsHtml(embedIndex, embed.fields, readOnly);
		const thumbnailHtml = buildThumbnailHtml(embed.thumbnail);
		const imageHtml = buildImageHtml(embed.image);
		const footerHtml = buildFooterHtml(embedIndex, embed.footer, embed.timestamp, readOnly);

		const removeBtnHtml = readOnly
			? ''
			: `<button type="button" class="embed-remove-btn" data-action="remove-embed" data-embed-index="${embedIndex}" title="Remove embed"><span class="field-btn field-btn-remove">-</span><span class="insert-label">Remove embed</span></button>`;

		return `
			<div class="embed-wrapper" data-diff-unit="embed.${embedIndex}">
				${removeBtnHtml}
				${colorBar}
				<div class="embed-content">
					<div class="embed-text">
						${thumbnailHtml}
						${authorHtml}
						${titleHtml}
						${descriptionHtml}
						${fieldsHtml}
					</div>
					${imageHtml}
					${footerHtml}
				</div>
			</div>`;
	}

	function buildAuthorHtml(embedIndex, author, readOnly) {
		const iconUrl = author && safeUrl(author.icon_url);
		const icon = iconUrl ? `<img src="${escapeAttr(iconUrl)}">` : '';
		const nameHtml = editablePiece(`embed.${embedIndex}.author.name`, author && author.name, {
			mode: 'plain',
			placeholder: 'Author name',
			tag: 'span',
			className: 'embed-author-name',
			linkUrl: author && safeUrl(author.url),
			readOnly
		});
		return `<div class="embed-author">${icon}${nameHtml}</div>`;
	}

	// Field name/value intentionally use mode 'md' (no headings) - Discord does
	// not render "#"/"##"/"###" headings inside embed fields, but it does render
	// lists ("- ") and subtext ("-# ") there, same as everywhere else.
	function buildFieldsHtml(embedIndex, fields, readOnly) {
		const list = Array.isArray(fields) ? fields : [];
		let html = readOnly ? '' : insertZone('add-field', { 'embed-index': embedIndex }, 0, 'Add field');
		let inlineRun = 0;
		list.forEach((f, j) => {
			html += buildFieldHtml(embedIndex, j, f, readOnly);
			if (readOnly) {
				return;
			}
			const isInline = !!(f && f.inline);
			const isLast = j === list.length - 1;
			const nextIsInline = !isLast && !!(list[j + 1] && list[j + 1].inline);

			if (isInline) {
				inlineRun++;
				// Every inline field gets its own small "add inline field" button
				// glued to its right, so you can grow a row even with just one
				// field in it (rather than only being able to insert between two
				// already-adjacent inline fields).
				html += smallAddFieldButton(embedIndex, j + 1);
				// Up to 3 inline fields fit per row; once a run keeps going past
				// that, offer a full-width divider (defaulting to non-inline) to
				// break onto the next row deliberately instead of leaving it to
				// however wrapping happens to fall out.
				if (nextIsInline && inlineRun % 3 === 0) {
					html += insertZone('add-field', { 'embed-index': embedIndex }, j + 1, 'Add field');
				}
			} else {
				inlineRun = 0;
			}

			if (isLast || !isInline || !nextIsInline) {
				html += insertZone('add-field', { 'embed-index': embedIndex }, j + 1, 'Add field');
			}
		});
		return `<div class="embed-fields">${html}</div>`;
	}

	function buildFieldHtml(embedIndex, fieldIndex, f, readOnly) {
		const isInline = !!(f && f.inline);
		const cls = isInline ? 'inline' : 'block';
		const toggleGlyph = isInline ? '—' : '||';
		const nameHtml = editablePiece(`embed.${embedIndex}.field.${fieldIndex}.name`, f && f.name, {
			mode: 'md',
			placeholder: 'Field name',
			className: 'embed-field-name',
			readOnly
		});
		const valueHtml = editablePiece(`embed.${embedIndex}.field.${fieldIndex}.value`, f && f.value, {
			mode: 'md',
			placeholder: 'Field value',
			className: 'embed-field-value',
			multiline: true,
			readOnly
		});
		const controlsHtml = readOnly
			? ''
			: `<div class="field-controls">
					<button type="button" class="field-btn" data-action="toggle-inline" data-embed-index="${embedIndex}" data-field-index="${fieldIndex}" title="Toggle inline">${toggleGlyph}</button>
					<button type="button" class="field-btn field-btn-remove" data-action="remove-field" data-embed-index="${embedIndex}" data-field-index="${fieldIndex}" title="Remove field">-</button>
				</div>`;
		return `
			<div class="embed-field ${cls}" data-diff-unit="embed.${embedIndex}.field.${fieldIndex}">
				<div class="embed-field-name-row">
					${controlsHtml}
					${nameHtml}
				</div>
				${valueHtml}
			</div>`;
	}

	function buildThumbnailHtml(thumbnail) {
		const url = thumbnail && safeUrl(thumbnail.url);
		if (!url) {
			return '';
		}
		return `<div class="embed-thumbnail"><img src="${escapeAttr(url)}"></div>`;
	}

	function buildImageHtml(image) {
		const url = image && safeUrl(image.url);
		if (!url) {
			return '';
		}
		return `<div class="embed-image"><img src="${escapeAttr(url)}"></div>`;
	}

	function buildFooterHtml(embedIndex, footer, timestamp, readOnly) {
		const iconUrl = footer && safeUrl(footer.icon_url);
		const icon = iconUrl ? `<img src="${escapeAttr(iconUrl)}">` : '';
		const textHtml = editablePiece(`embed.${embedIndex}.footer.text`, footer && footer.text, {
			mode: 'plain',
			placeholder: 'Footer text',
			tag: 'span',
			className: 'embed-footer-text',
			readOnly
		});
		const ts = formatTimestamp(timestamp);
		const tsHtml = ts ? `<span class="embed-footer-timestamp">${footer && footer.text ? ' • ' : ''}${escapeHtml(ts)}</span>` : '';
		return `<div class="embed-footer">${icon}${textHtml}${tsHtml}</div>`;
	}

	function formatTimestamp(timestamp) {
		if (!timestamp) {
			return '';
		}
		const date = new Date(timestamp);
		if (isNaN(date.getTime())) {
			return '';
		}
		return date.toLocaleString(undefined, {
			month: 'numeric',
			day: 'numeric',
			year: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		});
	}

	function intToHex(n) {
		const clamped = Math.max(0, Math.min(0xffffff, Math.floor(n)));
		return '#' + clamped.toString(16).padStart(6, '0');
	}

	function safeUrl(u) {
		if (typeof u !== 'string' || !u) {
			return null;
		}
		try {
			const parsed = new URL(u);
			if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
				return u;
			}
		} catch {
			// ignore
		}
		return null;
	}

	function escapeHtml(s) {
		return s
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	function escapeAttr(s) {
		return escapeHtml(s);
	}

	// opts.allowHeadings controls whether "# "/"## "/"### " lines become headings.
	// Lists ("- ") and subtext ("-# ") are always recognized regardless of that flag.
	function renderMarkdown(text, opts) {
		if (typeof text !== 'string') {
			return '';
		}
		const allowHeadings = !!(opts && opts.allowHeadings);

		let escaped = escapeHtml(text);

		const blocks = [];
		const stash = (html) => {
			const idx = blocks.push(html) - 1;
			return `@@MDSTASH${idx}@@`;
		};

		// Fenced code blocks can span multiple lines, so pull them out before the
		// line-by-line pass below (otherwise their contents could be mistaken for
		// headings/list items).
		escaped = escaped.replace(/```([\s\S]*?)```/g, (_, code) =>
			stash(`<pre class="md-codeblock"><code>${code.replace(/^[a-zA-Z0-9_-]*\n/, '')}</code></pre>`)
		);

		let out = escaped
			.split('\n')
			.map((line) => renderLine(line, allowHeadings, stash))
			.join('\n');

		out = out.replace(/@@MDSTASH(\d+)@@/g, (_, i) => blocks[Number(i)]);

		return out;
	}

	function renderLine(line, allowHeadings, stash) {
		if (/^@@MDSTASH\d+@@$/.test(line)) {
			return line;
		}

		const heading = allowHeadings && /^(#{1,3}) (.*)$/.exec(line);
		const subtext = !heading && /^-# (.*)$/.exec(line);
		const listItem = !heading && !subtext && /^- (.*)$/.exec(line);

		let content = line;
		let wrapClass = '';
		if (heading) {
			wrapClass = 'md-h' + heading[1].length;
			content = heading[2];
		} else if (subtext) {
			wrapClass = 'md-subtext';
			content = subtext[1];
		} else if (listItem) {
			content = listItem[1];
		}

		const inline = renderInline(content, stash);

		if (listItem) {
			return `<span class="md-list-item">• ${inline}</span>`;
		}
		if (wrapClass) {
			return `<span class="${wrapClass}">${inline}</span>`;
		}
		return inline;
	}

	function renderInline(text, stash) {
		let out = text;

		out = out.replace(/`([^`\n]+?)`/g, (_, code) => stash(`<code class="md-inline-code">${code}</code>`));

		out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');

		out = out.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
		out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
		out = out.replace(/__([^_]+)__/g, '<u>$1</u>');
		out = out.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
		out = out.replace(/(?<![a-zA-Z0-9_])_([^_\n]+)_(?![a-zA-Z0-9_])/g, '<em>$1</em>');
		out = out.replace(/~~([^~]+)~~/g, '<s>$1</s>');
		out = out.replace(/\|\|([^|]+)\|\|/g, '<span class="md-spoiler">$1</span>');

		out = out.replace(/&lt;@!?(\d+)&gt;/g, '<span class="md-mention">@user</span>');
		out = out.replace(/&lt;@&amp;(\d+)&gt;/g, '<span class="md-mention">@role</span>');
		out = out.replace(/&lt;#(\d+)&gt;/g, '<span class="md-mention">#channel</span>');
		out = out.replace(/&lt;a?:(\w+):(\d+)&gt;/g, '<span class="md-emoji">:$1:</span>');

		return out;
	}
})();
