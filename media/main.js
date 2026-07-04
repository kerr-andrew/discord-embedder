// @ts-check
(function () {
	const vscode = acquireVsCodeApi();
	const errorEl = /** @type {HTMLElement} */ (document.getElementById('error'));
	const rootEl = /** @type {HTMLElement} */ (document.getElementById('message-root'));
	const viewOnlyToggle = /** @type {HTMLButtonElement} */ (document.getElementById('view-only-toggle'));

	/** @type {any} */
	let model = null;
	let lastSentText = null;
	/** @type {ReturnType<typeof setTimeout> | undefined} */
	let writeDebounceTimer;
	let viewOnly = false;

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
		}
	});

	const prevState = vscode.getState();
	viewOnly = !!(prevState && prevState.viewOnly);
	if (prevState && prevState.text) {
		render(prevState.text);
	} else if (prevState) {
		renderPlaceholder();
	}
	applyViewOnlyState();

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

	function applyViewOnlyState() {
		document.body.classList.toggle('view-only', viewOnly);
		viewOnlyToggle.classList.toggle('active', viewOnly);
		viewOnlyToggle.textContent = viewOnly ? 'Exit view only' : 'View only';
		rootEl.querySelectorAll('.editable').forEach((el) => {
			el.setAttribute('contenteditable', viewOnly ? 'false' : 'true');
		});
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
		rootEl.innerHTML = buildRootHtml(model);
		applyViewOnlyState();
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
		rootEl.innerHTML = buildRootHtml(model);
		applyViewOnlyState();
		scheduleWrite();
	}

	// ---- editable text pieces (click-to-edit raw markdown / blur-to-render) ----

	function editablePiece(path, rawValue, opts) {
		const mode = opts.mode || 'plain'; // 'plain' | 'md' | 'md-heading'
		const placeholder = opts.placeholder || '';
		const tag = opts.tag || 'div';
		const cls = 'editable' + (opts.className ? ' ' + opts.className : '');
		const multiline = opts.multiline ? ' data-multiline="1"' : '';
		const linkUrl = opts.linkUrl ? ` data-link-url="${escapeAttr(opts.linkUrl)}"` : '';
		const raw = typeof rawValue === 'string' ? rawValue : '';
		const inner = renderPieceInner(mode, raw, placeholder, opts.linkUrl);
		return `<${tag} class="${cls}" data-bind="${escapeAttr(path)}" data-mode="${mode}" data-placeholder="${escapeAttr(placeholder)}"${multiline}${linkUrl} contenteditable="true" tabindex="0">${inner}</${tag}>`;
	}

	function renderPieceInner(mode, raw, placeholder, linkUrl) {
		if (!raw) {
			return `<span class="placeholder-text">${escapeHtml(placeholder)}</span>`;
		}
		if (mode === 'plain') {
			return linkUrl ? `<a href="${escapeAttr(linkUrl)}" target="_blank" rel="noreferrer">${escapeHtml(raw)}</a>` : escapeHtml(raw);
		}
		return renderMarkdown(raw, { allowHeadings: mode === 'md-heading' });
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
			// the description sits in the same container as the (floated)
			// thumbnail, so match the width it leaves available there instead
			// of letting it get pushed down.
			const embedText = el.closest('.embed-text');
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

	function buildRootHtml(m) {
		const embedsHtml = buildEmbedsListHtml(m.embeds);

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
			className: 'username'
		});
		const contentHtml = editablePiece('message.content', message.content, {
			mode: 'md-heading',
			placeholder: 'Add message content…',
			tag: 'div',
			className: 'message-content',
			multiline: true
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

	function buildEmbedsListHtml(embeds) {
		const list = Array.isArray(embeds) ? embeds : [];
		let html = insertZone('add-embed', {}, 0, 'Add embed');
		list.forEach((embed, i) => {
			html += buildEmbedHtml(embed, i);
			html += insertZone('add-embed', {}, i + 1, 'Add embed');
		});
		return html;
	}

	function buildEmbedHtml(embed, embedIndex) {
		if (!embed || typeof embed !== 'object') {
			embed = {};
		}

		const colorHex = typeof embed.color === 'number' ? intToHex(embed.color) : null;
		const colorBar = colorHex ? `<div class="embed-color-bar" style="background:${colorHex}"></div>` : '';

		const authorHtml = buildAuthorHtml(embedIndex, embed.author);
		const titleHtml = editablePiece(`embed.${embedIndex}.title`, embed.title, {
			mode: 'plain',
			placeholder: 'Title',
			className: 'embed-title',
			linkUrl: safeUrl(embed.url)
		});
		const descriptionHtml = editablePiece(`embed.${embedIndex}.description`, embed.description, {
			mode: 'md-heading',
			placeholder: 'Add description…',
			className: 'embed-description',
			multiline: true
		});
		const fieldsHtml = buildFieldsHtml(embedIndex, embed.fields);
		const thumbnailHtml = buildThumbnailHtml(embed.thumbnail);
		const imageHtml = buildImageHtml(embed.image);
		const footerHtml = buildFooterHtml(embedIndex, embed.footer, embed.timestamp);

		return `
			<div class="embed-wrapper">
				<button type="button" class="embed-remove-btn" data-action="remove-embed" data-embed-index="${embedIndex}" title="Remove embed"><span class="field-btn field-btn-remove">-</span><span class="insert-label">Remove embed</span></button>
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

	function buildAuthorHtml(embedIndex, author) {
		const iconUrl = author && safeUrl(author.icon_url);
		const icon = iconUrl ? `<img src="${escapeAttr(iconUrl)}">` : '';
		const nameHtml = editablePiece(`embed.${embedIndex}.author.name`, author && author.name, {
			mode: 'plain',
			placeholder: 'Author name',
			tag: 'span',
			className: 'embed-author-name',
			linkUrl: author && safeUrl(author.url)
		});
		return `<div class="embed-author">${icon}${nameHtml}</div>`;
	}

	// Field name/value intentionally use mode 'md' (no headings) - Discord does
	// not render "#"/"##"/"###" headings inside embed fields, but it does render
	// lists ("- ") and subtext ("-# ") there, same as everywhere else.
	function buildFieldsHtml(embedIndex, fields) {
		const list = Array.isArray(fields) ? fields : [];
		let html = insertZone('add-field', { 'embed-index': embedIndex }, 0, 'Add field');
		let inlineRun = 0;
		list.forEach((f, j) => {
			html += buildFieldHtml(embedIndex, j, f);
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

	function buildFieldHtml(embedIndex, fieldIndex, f) {
		const isInline = !!(f && f.inline);
		const cls = isInline ? 'inline' : 'block';
		const toggleGlyph = isInline ? '—' : '||';
		const nameHtml = editablePiece(`embed.${embedIndex}.field.${fieldIndex}.name`, f && f.name, {
			mode: 'md',
			placeholder: 'Field name',
			className: 'embed-field-name'
		});
		const valueHtml = editablePiece(`embed.${embedIndex}.field.${fieldIndex}.value`, f && f.value, {
			mode: 'md',
			placeholder: 'Field value',
			className: 'embed-field-value',
			multiline: true
		});
		return `
			<div class="embed-field ${cls}">
				<div class="embed-field-name-row">
					<div class="field-controls">
						<button type="button" class="field-btn" data-action="toggle-inline" data-embed-index="${embedIndex}" data-field-index="${fieldIndex}" title="Toggle inline">${toggleGlyph}</button>
						<button type="button" class="field-btn field-btn-remove" data-action="remove-field" data-embed-index="${embedIndex}" data-field-index="${fieldIndex}" title="Remove field">-</button>
					</div>
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

	function buildFooterHtml(embedIndex, footer, timestamp) {
		const iconUrl = footer && safeUrl(footer.icon_url);
		const icon = iconUrl ? `<img src="${escapeAttr(iconUrl)}">` : '';
		const textHtml = editablePiece(`embed.${embedIndex}.footer.text`, footer && footer.text, {
			mode: 'plain',
			placeholder: 'Footer text',
			tag: 'span',
			className: 'embed-footer-text'
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
