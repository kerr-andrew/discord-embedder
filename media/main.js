// @ts-check
(function () {
	const vscode = acquireVsCodeApi();
	const errorEl = /** @type {HTMLElement} */ (document.getElementById('error'));
	const rootEl = /** @type {HTMLElement} */ (document.getElementById('message-root'));

	window.addEventListener('message', (event) => {
		const msg = event.data;
		if (msg && msg.type === 'update') {
			vscode.setState({ text: msg.text });
			render(msg.text);
		} else if (msg && msg.type === 'empty') {
			vscode.setState({ text: null });
			renderPlaceholder();
		}
	});

	const prevState = vscode.getState();
	if (prevState && prevState.text) {
		render(prevState.text);
	} else if (prevState) {
		renderPlaceholder();
	}

	function renderPlaceholder() {
		hideError();
		rootEl.innerHTML = '<div class="placeholder">Open a JSON file to preview.</div>';
	}

	function render(rawText) {
		if (!rawText || !rawText.trim()) {
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
		rootEl.innerHTML = buildRootHtml(normalized);
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

	function normalize(parsed) {
		if (Array.isArray(parsed)) {
			return { message: null, embeds: parsed };
		}
		if (parsed && typeof parsed === 'object') {
			if (Array.isArray(parsed.embeds)) {
				return { message: parsed, embeds: parsed.embeds };
			}
			if (looksLikeEmbed(parsed)) {
				return { message: null, embeds: [parsed] };
			}
			if (typeof parsed.content === 'string') {
				return { message: parsed, embeds: [] };
			}
		}
		throw new Error(
			'Unrecognized JSON shape. Expected a Discord message object ({ content, embeds }), a bare embed array, or a single embed object.'
		);
	}

	function buildRootHtml(normalized) {
		const embedsHtml = normalized.embeds.map(buildEmbedHtml).join('');

		if (!normalized.message) {
			return `<div class="embeds-only">${embedsHtml}</div>`;
		}

		const message = normalized.message;
		const avatarUrl = safeUrl(message.avatar_url);
		const avatarHtml = avatarUrl
			? `<img class="avatar" src="${escapeAttr(avatarUrl)}">`
			: `<div class="avatar"></div>`;

		const username = typeof message.username === 'string' ? message.username : 'Bot';
		const botTag = message.username || message.avatar_url ? '<span class="bot-tag">BOT</span>' : '';
		const content =
			typeof message.content === 'string' && message.content.length
				? renderMarkdown(message.content, { allowHeadings: true })
				: '';

		return `
			<div class="discord-message">
				${avatarHtml}
				<div class="message-body">
					<div class="message-header">
						<span class="username">${escapeHtml(username)}</span>
						${botTag}
						<span class="timestamp">Today at 12:00 PM</span>
					</div>
					${content ? `<div class="message-content">${content}</div>` : ''}
					${embedsHtml}
				</div>
			</div>`;
	}

	function buildEmbedHtml(embed) {
		if (!embed || typeof embed !== 'object') {
			return '';
		}

		const colorHex = typeof embed.color === 'number' ? intToHex(embed.color) : null;
		const colorBar = colorHex ? `<div class="embed-color-bar" style="background:${colorHex}"></div>` : '';

		const authorHtml = buildAuthorHtml(embed.author);
		const titleHtml = buildTitleHtml(embed.title, embed.url);
		const descriptionHtml = embed.description
			? `<div class="embed-description">${renderMarkdown(String(embed.description), { allowHeadings: true })}</div>`
			: '';
		const fieldsHtml = buildFieldsHtml(embed.fields);
		const thumbnailHtml = buildThumbnailHtml(embed.thumbnail);
		const imageHtml = buildImageHtml(embed.image);
		const footerHtml = buildFooterHtml(embed.footer, embed.timestamp);

		return `
			<div class="embed-wrapper">
				${colorBar}
				<div class="embed-content">
					<div class="embed-main">
						<div class="embed-text">
							${authorHtml}
							${titleHtml}
							${descriptionHtml}
							${fieldsHtml}
						</div>
						${thumbnailHtml}
					</div>
					${imageHtml}
					${footerHtml}
				</div>
			</div>`;
	}

	function buildAuthorHtml(author) {
		if (!author || !author.name) {
			return '';
		}
		const iconUrl = safeUrl(author.icon_url);
		const icon = iconUrl ? `<img src="${escapeAttr(iconUrl)}">` : '';
		const url = safeUrl(author.url);
		const name = escapeHtml(String(author.name));
		const nameHtml = url ? `<a href="${escapeAttr(url)}" target="_blank" rel="noreferrer">${name}</a>` : name;
		return `<div class="embed-author">${icon}${nameHtml}</div>`;
	}

	function buildTitleHtml(title, url) {
		if (!title) {
			return '';
		}
		const escaped = escapeHtml(String(title));
		const safe = safeUrl(url);
		const inner = safe ? `<a href="${escapeAttr(safe)}" target="_blank" rel="noreferrer">${escaped}</a>` : escaped;
		return `<div class="embed-title">${inner}</div>`;
	}

	// Field name/value intentionally pass { allowHeadings: false } - Discord does not
	// render "#"/"##"/"###" headings inside embed fields, but it does render lists
	// ("- ") and subtext ("-# ") there, same as everywhere else.
	function buildFieldsHtml(fields) {
		if (!Array.isArray(fields) || fields.length === 0) {
			return '';
		}
		const items = fields
			.map((f) => {
				const cls = f && f.inline ? 'inline' : 'block';
				const name = f && f.name !== undefined ? renderMarkdown(String(f.name), { allowHeadings: false }) : '';
				const value = f && f.value !== undefined ? renderMarkdown(String(f.value), { allowHeadings: false }) : '';
				return `<div class="embed-field ${cls}">
					<div class="embed-field-name">${name}</div>
					<div class="embed-field-value">${value}</div>
				</div>`;
			})
			.join('');
		return `<div class="embed-fields">${items}</div>`;
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

	function buildFooterHtml(footer, timestamp) {
		const text = footer && typeof footer.text === 'string' ? footer.text : '';
		const ts = formatTimestamp(timestamp);
		if (!text && !ts) {
			return '';
		}
		const iconUrl = footer && safeUrl(footer.icon_url);
		const icon = iconUrl ? `<img src="${escapeAttr(iconUrl)}">` : '';
		const sep = text && ts ? ' • ' : '';
		return `<div class="embed-footer">${icon}<span>${escapeHtml(text)}${sep}${ts ? escapeHtml(ts) : ''}</span></div>`;
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
