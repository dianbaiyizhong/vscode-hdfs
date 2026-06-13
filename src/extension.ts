import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { HdfsClient } from './hdfsClient';
import { HdfsTreeDataProvider, HdfsNode, StoredConnection } from './hdfsTreeDataProvider';

let treeProvider: HdfsTreeDataProvider;

function loadConnections(context: vscode.ExtensionContext): StoredConnection[] {
  return context.globalState.get<StoredConnection[]>('hdfsConnections', []);
}

function saveConnections(context: vscode.ExtensionContext, conns: StoredConnection[]) {
  context.globalState.update('hdfsConnections', conns);
  treeProvider.connections = conns;
  treeProvider.refresh();
  vscode.commands.executeCommand('setContext', 'hdfs:hasConnections', conns.length > 0);
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function promptConnection(existing?: StoredConnection): Promise<StoredConnection | null> {
  const name = await vscode.window.showInputBox({
    title: existing ? 'Edit HDFS Connection' : 'New HDFS Connection',
    prompt: 'Connection name',
    placeHolder: 'My Hadoop Cluster',
    value: existing?.name,
    validateInput: (v) => v.trim() ? null : 'Name is required',
  });
  if (!name) return null;

  const host = await vscode.window.showInputBox({
    prompt: 'NameNode hostname or IP',
    placeHolder: 'namenode.example.com',
    value: existing?.host,
    validateInput: (v) => v.trim() ? null : 'Host is required',
  });
  if (!host) return null;

  const portStr = await vscode.window.showInputBox({
    prompt: 'WebHDFS port',
    placeHolder: '50070',
    value: String(existing?.port ?? '50070'),
    validateInput: (v) => /^\d+$/.test(v) ? null : 'Must be a number',
  });
  if (!portStr) return null;

  const protocolItems = [
    { label: 'http', description: 'Standard WebHDFS (port 50070)' },
    { label: 'https', description: 'Encrypted WebHDFS (port 50470)' },
  ];
  if (existing) {
    protocolItems.sort((a, b) => a.label === existing.protocol ? -1 : b.label === existing.protocol ? 1 : 0);
  }
  const protocol = await vscode.window.showQuickPick(protocolItems, {
    placeHolder: existing ? `Current: ${existing.protocol}` : 'Select protocol',
  });
  if (!protocol) return null;

  const authItems = [
    { label: 'SIMPLE', description: 'Username-based authentication' },
    { label: 'KERBEROS', description: 'Kerberos / SPNEGO (requires curl)' },
  ];
  if (existing) {
    authItems.sort((a, b) => a.label === existing.authMethod ? -1 : b.label === existing.authMethod ? 1 : 0);
  }
  const authPick = await vscode.window.showQuickPick(authItems, {
    placeHolder: existing ? `Current: ${existing.authMethod}` : 'Select authentication method',
  });
  if (!authPick) return null;

  let username = '';
  let curlPath = 'curl';
  if (authPick.label === 'SIMPLE') {
    const u = await vscode.window.showInputBox({
      prompt: 'HDFS username (optional for SIMPLE)',
      placeHolder: 'your-username',
      value: existing?.username,
    });
    username = u ?? '';
  } else {
    const c = await vscode.window.showInputBox({
      prompt: 'Path to curl binary',
      placeHolder: 'curl',
      value: existing?.curlPath || 'curl',
    });
    curlPath = c ?? 'curl';
  }

  return {
    id: existing?.id ?? generateId(),
    name,
    host,
    port: parseInt(portStr),
    protocol: protocol.label,
    authMethod: authPick.label as 'SIMPLE' | 'KERBEROS',
    username,
    curlPath,
  };
}

export function activate(context: vscode.ExtensionContext) {
  treeProvider = new HdfsTreeDataProvider();
  const conns = loadConnections(context);
  treeProvider.connections = conns;
  vscode.commands.executeCommand('setContext', 'hdfs:hasConnections', conns.length > 0);

  const treeView = vscode.window.createTreeView('hdfsExplorer', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  context.subscriptions.push(
    vscode.commands.registerCommand('hdfs.newConnection', async () => {
      const conn = await promptConnection();
      if (!conn) return;
      const list = [...treeProvider.connections, conn];
      saveConnections(context, list);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('hdfs.deleteConnection', async (node?: HdfsNode) => {
      if (!node || node.kind !== 'connection') return;
      const confirm = await vscode.window.showWarningMessage(
        `Delete connection "${node.connection!.name}"?`,
        { modal: true },
        'Delete'
      );
      if (confirm !== 'Delete') return;
      const list = treeProvider.connections.filter(c => c.id !== node.connection!.id);
      saveConnections(context, list);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('hdfs.editConnection', async (node?: HdfsNode) => {
      if (!node || node.kind !== 'connection') return;
      const updated = await promptConnection(node.connection!);
      if (!updated) return;
      updated.id = node.connection!.id;
      const list = treeProvider.connections.map(c =>
        c.id === updated.id ? updated : c
      );
      saveConnections(context, list);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('hdfs.refresh', (node?: HdfsNode) => {
      treeProvider.refresh(node);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('hdfs.createDirectory', async (node?: HdfsNode) => {
      if (!node || node.kind === 'file') return;
      const conn = resolveConnection(node);
      const parentPath = node.kind === 'connection' ? '/' : node.fullPath!;
      const name = await vscode.window.showInputBox({
        prompt: 'Enter directory name',
        placeHolder: 'new-directory',
      });
      if (!name) return;
      const newPath = parentPath === '/' ? '/' + name : parentPath + '/' + name;
      try {
        const client = treeProvider.getClient(conn);
        await client.mkdirs(newPath);
        treeProvider.refresh(node);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to create directory: ${e.message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('hdfs.delete', async (node?: HdfsNode) => {
      if (!node || node.kind === 'connection') return;
      const conn = resolveConnection(node);
      const isDir = node.kind === 'directory';
      const confirm = await vscode.window.showWarningMessage(
        `Delete ${isDir ? 'directory' : 'file'} "${node.fullPath}"?`,
        { modal: true },
        'Delete'
      );
      if (confirm !== 'Delete') return;
      try {
        const client = treeProvider.getClient(conn);
        await client.delete(node.fullPath!, isDir);
        treeProvider.refresh();
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to delete: ${e.message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('hdfs.rename', async (node?: HdfsNode) => {
      if (!node || node.kind === 'connection') return;
      const conn = resolveConnection(node);
      const currentName = node.fullPath!.split('/').pop() || '';
      const newName = await vscode.window.showInputBox({
        prompt: 'Rename to',
        value: currentName,
      });
      if (!newName || newName === currentName) return;
      const parent = node.fullPath!.substring(0, node.fullPath!.lastIndexOf('/')) || '/';
      const dest = parent === '/' ? '/' + newName : parent + '/' + newName;
      try {
        const client = treeProvider.getClient(conn);
        await client.rename(node.fullPath!, dest);
        treeProvider.refresh();
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to rename: ${e.message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('hdfs.upload', async (node?: HdfsNode) => {
      if (!node || node.kind === 'file') return;
      const conn = resolveConnection(node);
      const destDir = node.kind === 'connection' ? '/' : node.fullPath!;
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: true,
        canSelectFiles: true,
        canSelectFolders: false,
        title: 'Select files to upload to ' + destDir,
      });
      if (!uris || uris.length === 0) return;
      const client = treeProvider.getClient(conn);
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Uploading to HDFS...' },
        async (progress) => {
          for (let i = 0; i < uris.length; i++) {
            const localPath = uris[i].fsPath;
            const fileName = path.basename(localPath);
            const hdfsPath = destDir === '/' ? '/' + fileName : destDir + '/' + fileName;
            progress.report({ message: `${fileName} (${i + 1}/${uris.length})` });
            try {
              const content = fs.readFileSync(localPath);
              await client.writeFile(hdfsPath, content);
            } catch (e: any) {
              vscode.window.showErrorMessage(`Failed to upload ${fileName}: ${e.message}`);
            }
          }
          treeProvider.refresh(node);
          vscode.window.showInformationMessage(`Uploaded ${uris.length} file(s) to ${destDir}`);
        }
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('hdfs.download', async (node?: HdfsNode) => {
      if (!node || node.kind !== 'file') return;
      const conn = resolveConnection(node);
      const defaultName = node.fullPath!.split('/').pop() || 'file';
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(defaultName),
        title: 'Download ' + node.fullPath,
      });
      if (!uri) return;
      try {
        const client = treeProvider.getClient(conn);
        const content = await client.readFile(node.fullPath!);
        fs.writeFileSync(uri.fsPath, content);
        vscode.window.showInformationMessage(`Downloaded to ${uri.fsPath}`);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to download: ${e.message}`);
      }
    })
  );

  const contentProvider = new (class implements vscode.TextDocumentContentProvider {
    readonly onDidChange = new vscode.EventEmitter<vscode.Uri>().event;

    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
      const connId = uri.authority;
      const filePath = uri.path;
      const conn = treeProvider.connections.find(c => c.id === connId);
      if (!conn) return `// Connection not found: ${connId}`;
      try {
        const client = treeProvider.getClient(conn);
        const buf = await client.readFile(filePath);
        return buf.toString('utf-8');
      } catch (e: any) {
        return `// Error reading ${filePath}: ${e.message}`;
      }
    }
  })();

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('hdfs-file', contentProvider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('hdfs.openFile', async (node?: HdfsNode) => {
      if (!node || node.kind !== 'file') return;
      const conn = resolveConnection(node);
      const uri = vscode.Uri.parse(`hdfs-file://${conn.id}${node.fullPath}`);
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to open file: ${e.message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('hdfs.kinit', async () => {
      const principal = await vscode.window.showInputBox({
        prompt: 'Kerberos principal (optional, uses configured default)',
        placeHolder: 'user@REALM',
      });
      const keytab = await vscode.window.showInputBox({
        prompt: 'Path to keytab file (optional)',
        placeHolder: '/etc/krb5.keytab',
      });
      try {
        const args = ['-kt', keytab || '', principal || ''];
        const { execFile } = require('child_process');
        await new Promise<void>((resolve, reject) => {
          execFile('kinit', args, (err: any, _stdout: string, stderr: string) => {
            if (err) reject(new Error(`kinit failed: ${stderr || err.message}`));
            else resolve();
          });
        });
        vscode.window.showInformationMessage('Kerberos ticket initialized successfully');
      } catch (e: any) {
        vscode.window.showErrorMessage(`kinit failed: ${e.message}`);
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

function resolveConnection(node: HdfsNode): StoredConnection {
  if (node.kind === 'connection') return node.connection!;
  return treeProvider.connections.find(c => c.id === node.connectionId)!
    || treeProvider.connections[0];
}

export function deactivate() {}
