import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';

const VIEW_ID = 'discordEmbedPreviewer.view';

// Shells out to the git CLI directly rather than going through the built-in
// 'vscode.git' extension's API: that extension discovers repositories
// asynchronously on its own schedule (and may not have finished by the time
// we ask), so querying it can wrongly report "not a repository" for a file
// that plainly is one. A direct `git` call is synchronous-per-call and has
// no such race.
function execGit(args: string[], cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) {
				reject(new Error(stderr.toString() || error.message));
				return;
			}
			resolve(stdout.toString());
		});
	});
}

async function getRepoRoot(fsPath: string): Promise<string | null> {
	try {
		const out = await execGit(['rev-parse', '--show-toplevel'], path.dirname(fsPath));
		return out.trim();
	} catch {
		return null;
	}
}

export function activate(context: vscode.ExtensionContext) {
	const provider = new PreviewViewProvider(context.extensionUri);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
			webviewOptions: { retainContextWhenHidden: true }
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('discordEmbedPreviewer.preview', async () => {
			const editor = vscode.window.activeTextEditor;
			if (editor && editor.document.languageId === 'json') {
				provider.trackDocument(editor.document);
			}
			await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
		})
	);

	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor((editor) => {
			if (editor && editor.document.languageId === 'json') {
				provider.trackDocument(editor.document);
			}
		})
	);

	context.subscriptions.push(
		vscode.workspace.onDidChangeTextDocument((e) => {
			provider.onDocumentChanged(e.document);
		})
	);

	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument((doc) => {
			provider.onDocumentSaved(doc);
		})
	);

	context.subscriptions.push(
		vscode.workspace.onDidCloseTextDocument((doc) => {
			provider.onDocumentClosed(doc);
		})
	);
}

class PreviewViewProvider implements vscode.WebviewViewProvider {
	private view?: vscode.WebviewView;
	private trackedUri?: vscode.Uri;
	private debounceTimer?: ReturnType<typeof setTimeout>;

	constructor(private readonly extensionUri: vscode.Uri) {}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
		};
		webviewView.webview.html = getWebviewHtml(webviewView.webview, this.extensionUri);

		const messageListener = webviewView.webview.onDidReceiveMessage((msg) => {
			if (msg && msg.type === 'write') {
				this.applyWrite(msg.text);
			} else if (msg && msg.type === 'requestOriginal') {
				this.sendOriginal(msg.source);
			}
		});

		webviewView.onDidDispose(() => {
			messageListener.dispose();
			if (this.view === webviewView) {
				this.view = undefined;
			}
		});

		const editor = vscode.window.activeTextEditor;
		if (editor && editor.document.languageId === 'json') {
			this.trackDocument(editor.document);
		} else {
			this.sendEmpty();
		}
	}

	trackDocument(document: vscode.TextDocument) {
		this.trackedUri = document.uri;
		this.sendContent(document);
		this.sendGitStatus();
		this.sendSavedOriginal();
	}

	onDocumentChanged(document: vscode.TextDocument) {
		if (!this.trackedUri || document.uri.toString() !== this.trackedUri.toString()) {
			return;
		}
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}
		this.debounceTimer = setTimeout(() => this.sendContent(document), 150);
	}

	onDocumentSaved(document: vscode.TextDocument) {
		if (!this.trackedUri || document.uri.toString() !== this.trackedUri.toString()) {
			return;
		}
		this.sendSavedOriginal();
	}

	onDocumentClosed(document: vscode.TextDocument) {
		if (this.trackedUri && document.uri.toString() === this.trackedUri.toString()) {
			this.trackedUri = undefined;
			this.sendEmpty();
		}
	}

	private sendContent(document: vscode.TextDocument) {
		this.view?.webview.postMessage({ type: 'update', text: document.getText() });
	}

	private sendEmpty() {
		this.view?.webview.postMessage({ type: 'empty' });
	}

	private async sendGitStatus() {
		const uri = this.trackedUri;
		if (!uri) {
			return;
		}
		const repoRoot = await getRepoRoot(uri.fsPath);
		if (!this.trackedUri || this.trackedUri.toString() !== uri.toString()) {
			return; // tracked document changed while we were awaiting
		}
		this.view?.webview.postMessage({ type: 'gitStatus', isRepo: !!repoRoot });
	}

	private async sendSavedOriginal() {
		const uri = this.trackedUri;
		if (!uri) {
			return;
		}
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			if (!this.trackedUri || this.trackedUri.toString() !== uri.toString()) {
				return;
			}
			this.view?.webview.postMessage({ type: 'originalContent', source: 'save', text: Buffer.from(bytes).toString('utf8') });
		} catch {
			if (!this.trackedUri || this.trackedUri.toString() !== uri.toString()) {
				return;
			}
			this.view?.webview.postMessage({ type: 'originalContent', source: 'save', error: 'Could not read the saved file.' });
		}
	}

	private async sendOriginal(source: unknown) {
		if (source === 'save') {
			await this.sendSavedOriginal();
			return;
		}
		if (source !== 'commit') {
			return;
		}
		const uri = this.trackedUri;
		if (!uri) {
			return;
		}
		const repoRoot = await getRepoRoot(uri.fsPath);
		if (!this.trackedUri || this.trackedUri.toString() !== uri.toString()) {
			return;
		}
		if (!repoRoot) {
			this.view?.webview.postMessage({ type: 'originalContent', source: 'commit', error: 'Not a git repository.' });
			return;
		}
		const relPath = path.relative(repoRoot, uri.fsPath).split(path.sep).join('/');
		try {
			const text = await execGit(['show', `HEAD:${relPath}`], repoRoot);
			if (!this.trackedUri || this.trackedUri.toString() !== uri.toString()) {
				return;
			}
			this.view?.webview.postMessage({ type: 'originalContent', source: 'commit', text });
		} catch {
			if (!this.trackedUri || this.trackedUri.toString() !== uri.toString()) {
				return;
			}
			this.view?.webview.postMessage({
				type: 'originalContent',
				source: 'commit',
				error: 'No committed version of this file was found.'
			});
		}
	}

	private async applyWrite(text: string) {
		if (!this.trackedUri || typeof text !== 'string') {
			return;
		}
		const document = await vscode.workspace.openTextDocument(this.trackedUri);
		if (document.getText() === text) {
			return;
		}
		const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
		const edit = new vscode.WorkspaceEdit();
		edit.replace(document.uri, fullRange, text);
		await vscode.workspace.applyEdit(edit);
	}
}

function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.js'));
	const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.css'));
	const nonce = getNonce();

	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${styleUri}" rel="stylesheet">
	<title>Discord Embedder</title>
</head>
<body>
	<div id="app">
		<div id="toolbar">
			<div id="diff-options" class="diff-options" hidden>
				<button type="button" class="diff-source-btn" data-source="commit" title="Compare against the last git commit">Last commit</button>
				<button type="button" class="diff-source-btn" data-source="save" title="Compare against the last saved version">Last save</button>
				<button type="button" id="diff-highlight-toggle" class="toolbar-btn" title="Highlight added and removed text between the two panes">Highlight changes</button>
			</div>
			<div class="toolbar-actions">
				<button type="button" id="diff-toggle" class="toolbar-btn" title="Compare the current embed against an earlier version">Diff view</button>
				<button type="button" id="view-only-toggle" class="toolbar-btn" title="Hide edit controls and show only how the embed will display">View only</button>
			</div>
		</div>
		<div id="panels">
			<div id="original-pane" class="pane" hidden>
				<div class="pane-label">Original</div>
				<div id="original-error" class="error-banner" hidden></div>
				<div id="original-root" class="readonly-pane"></div>
			</div>
			<div id="current-pane" class="pane">
				<div class="pane-label" id="current-pane-label" hidden>Current</div>
				<div id="error" class="error-banner" hidden></div>
				<div id="message-root"></div>
			</div>
		</div>
	</div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

export function deactivate() {}
