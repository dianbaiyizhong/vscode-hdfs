import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ConnectionManager } from './connectionManager';
import { HdfsTreeDataProvider, HdfsTreeItem } from './treeView';
import { HdfsClient } from './hdfsClient';
import { registerCommands } from './commands';
import { JumpHistory } from './jumpHistory';
import { taskManager } from './taskManager';
import { SettingsPanel } from './settingsPanel';
import { FolderBrowserPanel } from './folderBrowserPanel';
import { TaskViewPanel } from './taskViewPanel';
import { initI18n } from './i18n';

let treeProvider: HdfsTreeDataProvider;

export function activate(context: vscode.ExtensionContext): void {
  initI18n();

  const connectionManager = new ConnectionManager(context);
  treeProvider = new HdfsTreeDataProvider(connectionManager, context.extensionUri);
  SettingsPanel.extensionUri = context.extensionUri;
  FolderBrowserPanel.extensionUri = context.extensionUri;
  TaskViewPanel.extensionUri = context.extensionUri;
  const jumpHistory = new JumpHistory(context.globalState);
  taskManager.init(context.globalState);

  vscode.commands.executeCommand('setContext', 'hdfs:hasConnections', connectionManager.connections.length > 0);

  const treeView = vscode.window.createTreeView('hdfsExplorer', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
    dragAndDropController: {
      dragMimeTypes: [],
      dropMimeTypes: ['text/uri-list', 'files'],
      handleDrop: async (target: HdfsTreeItem | undefined, sources: vscode.DataTransfer) => {
        if (!target || !target.connectionId) return;
        const conn = connectionManager.getConnection(target.connectionId);
        if (!conn) return;

        const uploads: { name: string; read: () => Thenable<Uint8Array> }[] = [];

        const uriItem = sources.get('text/uri-list');
        if (uriItem) {
          const text = await uriItem.asString();
          for (const line of text.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('file://')) continue;
            try {
              const uri = vscode.Uri.parse(trimmed);
              const name = path.basename(uri.fsPath);
              if (name) uploads.push({ name, read: () => vscode.workspace.fs.readFile(uri) });
            } catch { /* skip invalid URI */ }
          }
        }

        const fileItem = sources.get('files');
        if (fileItem) {
          const file = fileItem.asFile();
          if (file) {
            uploads.push({ name: file.name, read: () => file.data() });
          }
        }

        if (uploads.length === 0) return;

        const client = new HdfsClient({
          serviceUrl: conn.serviceUrl,
          sessionId: conn.sessionId || undefined,
          coreSitePath: conn.coreSitePath || undefined,
          hdfsSitePath: conn.hdfsSitePath || undefined,
          krb5ConfPath: conn.krb5ConfPath || undefined,
          keytabPath: conn.keytabPath || undefined,
          principal: conn.principal || undefined,
        });
        const destDir = '/';
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Uploading to ' + destDir },
          async (progress) => {
            for (let i = 0; i < uploads.length; i++) {
              const { name, read } = uploads[i];
              progress.report({ message: name + ' (' + (i + 1) + '/' + uploads.length + ')' });
              try {
                const content = Buffer.from(await read());
                await client.writeFile(destDir === '/' ? '/' + name : destDir + '/' + name, content);
              } catch (e: any) {
                vscode.window.showErrorMessage('Upload failed: ' + name + ' - ' + e.message);
              }
            }
            treeProvider.refresh();
          }
        );
      },
    },
  });
  context.subscriptions.push(treeView);

  registerCommands(context, connectionManager, treeProvider, jumpHistory);

  const contentProvider = new (class implements vscode.TextDocumentContentProvider {
    readonly onDidChange = new vscode.EventEmitter<vscode.Uri>().event;

    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
      const connId = uri.authority;
      const filePath = uri.path;
      const conn = connectionManager.getConnection(connId);
      if (!conn) return '// Connection not found: ' + connId;
      try {
        const client = new HdfsClient({
          serviceUrl: conn.serviceUrl,
          sessionId: conn.sessionId || undefined,
          coreSitePath: conn.coreSitePath || undefined,
          hdfsSitePath: conn.hdfsSitePath || undefined,
          krb5ConfPath: conn.krb5ConfPath || undefined,
          keytabPath: conn.keytabPath || undefined,
          principal: conn.principal || undefined,
        });
        const buf = await client.readFile(filePath);
        return buf.toString('utf-8');
      } catch (e: any) {
        return '// Error reading ' + filePath + ': ' + e.message;
      }
    }
  })();

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('hdfs-file', contentProvider)
  );

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer('hdfsTaskView', {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        try { panel.dispose(); } catch { /* already disposed */ }
      }
    }),
    vscode.window.registerWebviewPanelSerializer('folderBrowser', {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        try { panel.dispose(); } catch { /* already disposed */ }
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('hdfs')) {
        treeProvider.refresh();
      }
    })
  );
}

export function deactivate() {}
