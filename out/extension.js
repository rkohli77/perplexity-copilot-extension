"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const dotenv = __importStar(require("dotenv"));
dotenv.config({ path: path.join(__dirname, "..", ".env") });
// Extension-wide output channel for logging
const extensionOutputChannel = vscode.window.createOutputChannel("Perplexity Extension");
// Safe fetch fallback using node-fetch if not present
let fetchFn = undefined;
// getFetch returns fetch with type any to avoid DOM/Node Response typing issues
const getFetch = () => globalThis.fetch
    ? globalThis.fetch
    : (fetchFn ??
        (fetchFn = async (...args) => {
            const mod = await Promise.resolve().then(() => __importStar(require("node-fetch")));
            const fetchFnAny = (mod.default ?? mod);
            return fetchFnAny(...args);
        }));
class PerplexityChatProvider {
    constructor(_extensionUri, _context) {
        this._extensionUri = _extensionUri;
        this._context = _context;
        this._pendingMessages = [];
        // Initialize debug output first so we can use log()
        this.outputChannel = vscode.window.createOutputChannel("Perplexity Debug");
        this.outputChannel.show(true);
        // Initialize state
        this._sidebarReady = false;
        this._webviewReady = false;
        this._apiKey = undefined; // Will be set by loadApiKey() or setApiKey()
        this._pendingMessages = [];
        try {
            // Synchronously initialize from workspace settings or environment variable
            const configKey = vscode.workspace.getConfiguration("perplexity").get("apiKey");
            const envKey = process.env.PERPLEXITY_API_KEY;
            if (configKey || envKey) {
                this._apiKey = configKey || envKey;
                this.log("Initialized API key from config/env");
            }
        }
        catch (err) {
            this.log("Error during constructor initialization:", err);
        }
        this.log("PerplexityChatProvider constructed — sidebarReady=false, webviewReady=false");
    }
    log(...args) {
        const message = args
            .map(a => (typeof a === "string" ? a : JSON.stringify(a, null, 2)))
            .join(" ");
        this.outputChannel.appendLine(`[PerplexityChatProvider] ${message}`);
    }
    focusInput() {
        if (this._view && this._sidebarReady && this._webviewReady) {
            this._view.webview.postMessage({ command: "focusInput" });
        }
    }
    /**
     * Asynchronously load API key from SecretStorage and update _apiKey if found.
     * Call this after construction if you want to prefer SecretStorage key.
     */
    async loadApiKey() {
        if (this._context) {
            const secretKey = await this._context.secrets.get("perplexity.apiKey");
            if (secretKey) {
                this._apiKey = secretKey;
            }
        }
    }
    setApiKey(key) {
        this._apiKey = key;
    }
    isSidebarLoaded() {
        return !!this._view && this._sidebarReady && this._webviewReady;
    }
    resolveWebviewView(webviewView) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        // Attach handler first to prevent race condition
        webviewView.webview.onDidReceiveMessage(async (message) => {
            try {
                this.log("Received webview message:", message);
                if (message.command === "ask") {
                    const answer = await this.askPerplexity(message.text);
                    this._view?.webview.postMessage({ command: "answer", text: answer });
                }
                else if (message.command === "ready") {
                    this._webviewReady = true;
                    this.log("Webview signaled ready — webviewReady = true ✅");
                    // flush queued messages now
                    if (this._pendingMessages.length > 0) {
                        this.log(`Flushing ${this._pendingMessages.length} queued messages`);
                        for (const msg of this._pendingMessages) {
                            this._view.webview.postMessage({ command: "initialPrompt", text: msg });
                            this.log("Flushed queued prompt:", msg);
                        }
                        this._pendingMessages = [];
                    }
                    this.focusInput();
                }
                else if (message.command === "initialPrompt" && message.text) {
                    const answer = await this.askPerplexity(message.text);
                    this._view?.webview.postMessage({ command: "answer", text: answer });
                }
            }
            catch (err) {
                this.log("Error handling webview message:", err);
                const errorMessage = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`Perplexity error: ${errorMessage}`);
            }
        });
        // Now assign HTML (after handler is attached)
        webviewView.webview.html = this._getHtml();
        this._sidebarReady = true;
        this._webviewReady = false;
        this.log("Sidebar view resolved — sidebarReady = true, webviewReady = false");
    }
    async sendMessage(prompt) {
        this.log(`sendMessage called with prompt="${prompt}" sidebarReady=${this._sidebarReady} webviewReady=${this._webviewReady}`);
        if (!this.isSidebarLoaded()) {
            this._pendingMessages.push(prompt);
            this.log("Sidebar not ready — queuing prompt:", prompt);
            return;
        }
        // flush queued messages
        for (const msg of this._pendingMessages) {
            this._view.webview.postMessage({ command: "initialPrompt", text: msg });
            this.log("Flushed queued prompt:", msg);
        }
        this._pendingMessages = [];
        // send current prompt
        this._view.webview.postMessage({ command: "initialPrompt", text: prompt });
        this.log("Sent prompt:", prompt);
    }
    async ask(prompt) {
        return this.askPerplexity(prompt);
    }
    async askPerplexity(prompt) {
        // _apiKey is initialized synchronously from settings/env in constructor.
        // If you want to update from SecretStorage, call loadApiKey() after construction.
        if (!this._apiKey) {
            vscode.window.showErrorMessage("Perplexity: missing API key. Set `perplexity.apiKey` in Settings, SecretStorage, or PERPLEXITY_API_KEY in environment.");
            return "❌ Missing API key.";
        }
        // Continue with the API request using this._apiKey...
        const payload = {
            model: vscode.workspace.getConfiguration("perplexity").get("model") || "sonar",
            messages: [{ role: "user", content: prompt }],
        };
        const fetch = getFetch();
        const res = await fetch("https://api.perplexity.ai/chat/completions", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${this._apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
        });
        if (!res.ok) {
            const text = await res.text();
            return `❌ API request failed: ${res.status} ${res.statusText} - ${text}`;
        }
        const data = await res.json();
        return data.choices?.[0]?.message?.content || "⚠️ No response received.";
    }
    _getHtml() {
        // Webview HTML with auto-scroll and input focus
        return `
      <html>
        <head><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
        <body style="background:#1e1e1e;color:#ccc;font-family:monospace;padding:10px;">
          <h3>💬 Perplexity Copilot</h3>
          <div id="chat" style="height:300px;overflow:auto;border:1px solid #333;padding:8px;margin-bottom:10px;"></div>
          <input id="prompt" autofocus style="width:100%;padding:6px;background:#2a2a2a;color:white;border:none;" placeholder="Ask Perplexity..."/>
          <script>
            const vscode = acquireVsCodeApi();
            const chat = document.getElementById('chat');
            const input = document.getElementById('prompt');
            function escapeHTML(str) {
              return str.replace(/[&<>"']/g, function(m) {
                return ({
                  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
                })[m];
              });
            }
            function scrollToBottom() {
              chat.scrollTop = chat.scrollHeight;
            }
            function focusInput() {
              input.focus();
            }
            input.addEventListener('keydown', (e) => {
              if(e.key === 'Enter' && input.value.trim()){
                vscode.postMessage({command:'ask', text: input.value});
                chat.innerHTML += '<div><b>You:</b> ' + escapeHTML(input.value) + '</div>';
                input.value='';
                setTimeout(scrollToBottom, 10);
                setTimeout(focusInput, 10);
              }
            });
            window.addEventListener('message', (event) => {
              const message = event.data;
              if(message.command === 'answer'){
                  const div = document.createElement('div');
                  div.style.marginTop = '8px';
                  const strong = document.createElement('b');
                  strong.textContent = 'Perplexity:';
                  div.appendChild(strong);
                  const textNode = document.createTextNode(' ' + message.text);
                  div.appendChild(textNode);
                  chat.appendChild(div);
                  scrollToBottom();
                  setTimeout(focusInput, 10);
              } else if (message.command === 'ready') {
                // Sidebar loaded, can handle initialPrompt
              } else if (message.command === 'initialPrompt' && message.text) {
                chat.innerHTML += '<div><b>You:</b> ' + escapeHTML(message.text) + '</div>';
                vscode.postMessage({command:'ask', text: message.text});
                setTimeout(scrollToBottom, 10);
                setTimeout(focusInput, 10);
              } else if (message.command === 'focusInput') {
                focusInput();
              }
            });
            // Notify extension that sidebar is ready (delayed)
            window.addEventListener('load', () => {
              setTimeout(() => {
                vscode.postMessage({ command: 'ready' });
              }, 50);
            });
            // Do not focus input immediately; let extension call focusInput after ready
          </script>
        </body>
      </html>
    `;
    }
}
function activate(context) {
    const outputChannel = vscode.window.createOutputChannel("Perplexity Extension");
    outputChannel.show(true);
    try {
        outputChannel.appendLine("Starting extension activation");
        vscode.window.showInformationMessage("Perplexity Copilot activated");
        const provider = new PerplexityChatProvider(context.extensionUri, context);
        outputChannel.appendLine("Created PerplexityChatProvider instance");
        // Load API key from SecretStorage first
        provider.loadApiKey().then(() => {
            outputChannel.appendLine("API key loaded from SecretStorage");
        }).catch(err => {
            outputChannel.appendLine(`Failed to load API key from SecretStorage: ${err}`);
        });
        provider.log("Provider instance created");
        context.subscriptions.push(vscode.window.registerWebviewViewProvider("perplexityChat", provider, {
            webviewOptions: { retainContextWhenHidden: true }
        }));
        // Command: show Perplexity sidebar and focus input
        context.subscriptions.push(vscode.commands.registerCommand("perplexity.showSidebar", async () => {
            await vscode.commands.executeCommand("workbench.view.perplexity-copilot");
            // Wait for the webview to be ready before focusing
            if (provider.isSidebarLoaded()) {
                provider.focusInput();
                vscode.window.showInformationMessage("Perplexity Copilot ready in sidebar.");
            }
            provider.log("showSidebar command executed");
        }));
        // Command: ask Perplexity
        context.subscriptions.push(vscode.commands.registerCommand("perplexity.ask", async () => {
            const input = await vscode.window.showInputBox({ prompt: "Ask Perplexity AI" });
            if (input) {
                // Try sidebar first, fallback to panel
                if (provider.isSidebarLoaded()) {
                    provider.sendMessage(input);
                }
                else {
                    PerplexityChatPanel.createOrShow(context.extensionUri, provider, input);
                }
            }
        }));
        // Command: show config
        context.subscriptions.push(vscode.commands.registerCommand("perplexity.showConfig", async () => {
            const cfgKey = vscode.workspace.getConfiguration("perplexity").get("apiKey") || "";
            const envKey = process.env.PERPLEXITY_API_KEY || "";
            const secretKey = await context.secrets.get("perplexity.apiKey") || "";
            const cfgModel = vscode.workspace.getConfiguration("perplexity").get("model") || "";
            const activeKey = secretKey || cfgKey || envKey;
            const masked = activeKey ? (activeKey.length > 4 ? "****" + activeKey.slice(-4) : "****") : "(none)";
            const source = secretKey ? "secret" : (cfgKey ? "settings" : (envKey ? "env" : "none"));
            vscode.window.showInformationMessage(`Perplexity key: ${masked} (source: ${source}) model: ${cfgModel || "(default)"}`);
        }));
        // Command: set API key
        context.subscriptions.push(vscode.commands.registerCommand("perplexity.setApiKey", async () => {
            const key = await vscode.window.showInputBox({
                prompt: "Enter Perplexity API key",
                placeHolder: "sk_...",
                ignoreFocusOut: true,
            });
            if (key) {
                await context.secrets.store("perplexity.apiKey", key);
                vscode.window.showInformationMessage("Perplexity API key saved to SecretStorage");
                provider.setApiKey(key);
            }
        }));
        // Command: open chat panel fallback
        context.subscriptions.push(vscode.commands.registerCommand("perplexity.openChatPanel", async () => {
            PerplexityChatPanel.createOrShow(context.extensionUri, provider);
        }));
        // Command: pick model
        context.subscriptions.push(vscode.commands.registerCommand("perplexity.pickModel", async () => {
            const cacheKey = "perplexity.models.cache";
            const cacheTtl = 1000 * 60 * 60 * 24;
            let cached = context.globalState.get(cacheKey);
            const now = Date.now();
            if (!cached || now - cached.timestamp > cacheTtl || !Array.isArray(cached.models) || !cached.models.length) {
                try {
                    const fetch = getFetch();
                    const res = await fetch("https://api.perplexity.ai/models", { method: "GET" });
                    if (res.ok) {
                        const body = await res.json();
                        let modelsRaw = [];
                        if (Array.isArray(body))
                            modelsRaw = body;
                        else if (Array.isArray(body?.models))
                            modelsRaw = body.models;
                        const models = modelsRaw.map(m => {
                            if (typeof m === "string")
                                return { id: m, desc: "" };
                            return { id: m.id || m.name || String(m), desc: m.description || m.desc || "" };
                        }).filter(Boolean);
                        if (models.length) {
                            cached = { timestamp: now, models };
                            await context.globalState.update(cacheKey, cached);
                        }
                    }
                }
                catch { }
            }
            const fallback = [
                { id: "pplx-13b-online", desc: "Smaller, faster" },
                { id: "pplx-70b-online", desc: "Largest (may require access)" },
                { id: "", desc: "Server default" },
            ];
            const modelsToShow = (cached?.models && cached.models.length) ? cached.models : fallback;
            const items = modelsToShow.map(m => ({
                label: m.id || "(server default)",
                description: m.desc || "",
            }));
            const choice = await vscode.window.showQuickPick(items, { placeHolder: "Select Perplexity model" });
            if (choice) {
                const cfg = vscode.workspace.getConfiguration("perplexity");
                const toSet = (choice.label === "(server default)" || choice.label === "") ? "" : choice.label;
                await cfg.update("model", toSet, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(`Perplexity model set to: ${toSet || "(server default)"}`);
            }
        }));
    }
    catch (err) {
        outputChannel.appendLine(`Error during activation: ${err}`);
    }
}
class PerplexityChatPanel {
    static createOrShow(extensionUri, provider, initialPrompt) {
        const column = vscode.window.activeTextEditor?.viewColumn;
        if (PerplexityChatPanel.currentPanel) {
            PerplexityChatPanel.currentPanel._panel.reveal(column);
            if (initialPrompt) {
                PerplexityChatPanel.currentPanel.sendInitialPrompt(initialPrompt);
            }
            return;
        }
        const panel = vscode.window.createWebviewPanel("perplexityChatPanel", "Perplexity Chat", column || vscode.ViewColumn.One, { enableScripts: true });
        PerplexityChatPanel.currentPanel = new PerplexityChatPanel(panel, provider, initialPrompt);
    }
    constructor(panel, provider, initialPrompt) {
        this._panel = panel;
        this._provider = provider;
        this._panel.webview.html = this._getHtml();
        this._panel.webview.onDidReceiveMessage(async (message) => {
            if (message.command === "ask") {
                const answer = await this._provider.ask(message.text);
                this._panel.webview.postMessage({ command: "answer", text: answer });
            }
            else if (message.command === "initialPrompt" && message.text) {
                const answer = await this._provider.ask(message.text);
                this._panel.webview.postMessage({ command: "answer", text: answer });
            }
        });
        this._panel.onDidDispose(() => {
            PerplexityChatPanel.currentPanel = undefined;
        });
        // If initialPrompt is provided, send it after a short delay to allow webview to load
        if (initialPrompt) {
            setTimeout(() => {
                this.sendInitialPrompt(initialPrompt);
            }, 200);
        }
    }
    sendInitialPrompt(prompt) {
        this._panel.webview.postMessage({ command: "initialPrompt", text: prompt });
    }
    _getHtml() {
        return `
      <html>
        <head><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
        <body style="background:#1e1e1e;color:#ccc;font-family:monospace;padding:10px;">
          <h3>💬 Perplexity Copilot (Panel)</h3>
          <div id="chat" style="height:300px;overflow:auto;border:1px solid #333;padding:8px;margin-bottom:10px;"></div>
          <input id="prompt" autofocus style="width:100%;padding:6px;background:#2a2a2a;color:white;border:none;" placeholder="Ask Perplexity..."/>
          <script>
            const vscode = acquireVsCodeApi();
            const chat = document.getElementById('chat');
            const input = document.getElementById('prompt');
            function escapeHTML(str) {
              return str.replace(/[&<>"']/g, function(m) {
                return ({
                  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
                })[m];
              });
            }
            function scrollToBottom() {
              chat.scrollTop = chat.scrollHeight;
            }
            function focusInput() {
              input.focus();
            }
            input.addEventListener('keydown', (e) => {
              if(e.key === 'Enter' && input.value.trim()){
                vscode.postMessage({command:'ask', text: input.value});
                chat.innerHTML += '<div><b>You:</b> ' + escapeHTML(input.value) + '</div>';
                input.value='';
                setTimeout(scrollToBottom, 10);
                setTimeout(focusInput, 10);
              }
            });
            window.addEventListener('message', (event) => {
              const message = event.data;
              if(message.command === 'answer'){
                  const div = document.createElement('div');
                  div.style.marginTop = '8px';
                  const strong = document.createElement('b');
                  strong.textContent = 'Perplexity:';
                  div.appendChild(strong);
                  const textNode = document.createTextNode(' ' + message.text);
                  div.appendChild(textNode);
                  chat.appendChild(div);
                  scrollToBottom();
                  setTimeout(focusInput, 10);
              } else if (message.command === 'initialPrompt' && message.text) {
                chat.innerHTML += '<div><b>You:</b> ' + escapeHTML(message.text) + '</div>';
                vscode.postMessage({command:'ask', text: message.text});
                setTimeout(scrollToBottom, 10);
                setTimeout(focusInput, 10);
              }
            });
            window.addEventListener('load', () => {
              setTimeout(() => {
                  vscode.postMessage({ command: 'ready' });
              }, 50);
            });
            setTimeout(focusInput, 30);
          </script>
        </body>
      </html>
    `;
    }
}
//# sourceMappingURL=extension.js.map