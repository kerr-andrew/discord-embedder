import * as vscode from 'vscode';

const VIEW_ID = 'discordEmbedPreviewer.view';

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
	<title>Discord Embed Preview</title>
</head>
<body>
	<div id="app">
		<div id="error" class="error-banner" hidden></div>
		<div id="message-root"></div>
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
