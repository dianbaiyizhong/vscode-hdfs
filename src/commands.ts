import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ConnectionManager, HdfsConnection } from './connectionManager';
import { HdfsTreeItem, HdfsTreeDataProvider } from './treeView';
import { HdfsClient } from './hdfsClient';
import { t } from './i18n';
import { JumpHistory } from './jumpHistory';
import { taskManager } from './taskManager';
import { FolderBrowserPanel } from './folderBrowserPanel';
import { TaskViewPanel } from './taskViewPanel';
import { SettingsPanel } from './settingsPanel';

export function registerCommands(
  context: vscode.ExtensionContext,
  connectionManager: ConnectionManager,
  treeProvider: HdfsTreeDataProvider,
  jumpHistory: JumpHistory
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('hdfs.openSettings', () =>
      SettingsPanel.createOrShow(connectionManager)
    ),
    vscode.commands.registerCommand('hdfs.newConnection', () =>
      SettingsPanel.createOrShow(connectionManager)
    ),
    vscode.commands.registerCommand('hdfs.editConnection', (item: HdfsTreeItem) =>
      SettingsPanel.createOrShow(connectionManager, item?.connectionId)
    ),
    vscode.commands.registerCommand('hdfs.refresh', (item?: HdfsTreeItem) =>
      treeProvider.refresh(item)
    ),
    vscode.commands.registerCommand('hdfs.deleteConnection', (item: HdfsTreeItem) =>
      deleteConnection(connectionManager, treeProvider, item)
    ),
    vscode.commands.registerCommand('hdfs.openConnection', (item: HdfsTreeItem) =>
      handleOpenConnection(connectionManager, item, jumpHistory)
    ),
    vscode.commands.registerCommand('hdfs.goToPath', (item: HdfsTreeItem) =>
      handleGoToPath(connectionManager, item, jumpHistory)
    ),
    vscode.commands.registerCommand('hdfs.openTaskView', () =>
      TaskViewPanel.createOrShow()
    ),
    vscode.commands.registerCommand('hdfs.kinit', () =>
      handleKinit(connectionManager)
    ),
    vscode.commands.registerCommand('hdfs.createDirectory', async (node: any) => {
      const conn = resolveConnection(node, connectionManager);
      if (!conn) return;
      const destDir = node && node.fullPath ? node.fullPath : '/';
      const name = await vscode.window.showInputBox({
        title: t('prompt_newFolderName'),
        placeHolder: t('prompt_newFolder_placeholder'),
      });
      if (!name) return;
      const client = createClientFromConn(conn);
      try {
        const newPath = destDir === '/' ? '/' + name : destDir + '/' + name;
        await client.mkdirs(newPath);
        treeProvider.refresh();
      } catch (e: any) {
        vscode.window.showErrorMessage(t('msg_folderFailed', e.message));
      }
    }),
    vscode.commands.registerCommand('hdfs.delete', async (node: any) => {
      const conn = resolveConnection(node, connectionManager);
      if (!conn || !node || !node.fullPath) return;
      const isDir = node.kind === 'directory' || node.fileStatus?.type === 'DIRECTORY';
      const deleteBtn = t('msg_deleteBtn');
      const msgKey = isDir ? 'msg_deleteFolderConfirm' : 'msg_deleteConfirm';
      const name = node.fullPath?.split('/').pop() || '';
      const confirmed = await vscode.window.showWarningMessage(
        t(msgKey, name), { modal: true }, deleteBtn
      );
      if (confirmed !== deleteBtn) return;
      const client = createClientFromConn(conn);
      try {
        await client.delete(node.fullPath, isDir);
        treeProvider.refresh();
      } catch (e: any) {
        vscode.window.showErrorMessage('Failed to delete: ' + e.message);
      }
    }),
    vscode.commands.registerCommand('hdfs.rename', async (node: any) => {
      const conn = resolveConnection(node, connectionManager);
      if (!conn || !node || !node.fullPath) return;
      const currentName = node.fullPath.split('/').pop() || '';
      const newName = await vscode.window.showInputBox({
        title: t('prompt_rename_file'), value: currentName,
      });
      if (!newName || newName === currentName) return;
      const parent = node.fullPath.substring(0, node.fullPath.lastIndexOf('/')) || '/';
      const dest = parent === '/' ? '/' + newName : parent + '/' + newName;
      const client = createClientFromConn(conn);
      try {
        await client.rename(node.fullPath, dest);
        treeProvider.refresh();
      } catch (e: any) {
        vscode.window.showErrorMessage(t('msg_renameFailed', e.message));
      }
    }),
    vscode.commands.registerCommand('hdfs.upload', async (node: any) => {
      const conn = resolveConnection(node, connectionManager);
      if (!conn) return;
      const destDir = node && node.fullPath ? node.fullPath : '/';
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: true, canSelectFiles: true, canSelectFolders: false,
        title: 'Select files to upload to ' + destDir,
      });
      if (!uris || uris.length === 0) return;
      const client = createClientFromConn(conn);
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Uploading to HDFS...' },
        async (progress) => {
          for (let i = 0; i < uris.length; i++) {
            const localPath = uris[i].fsPath;
            const fileName = path.basename(localPath);
            const hdfsPath = destDir === '/' ? '/' + fileName : destDir + '/' + fileName;
            progress.report({ message: fileName + ' (' + (i + 1) + '/' + uris.length + ')' });
            const taskId = taskManager.add({
              type: 'upload', fileName, size: fs.statSync(localPath).size,
              source: localPath, destination: hdfsPath, connectionName: conn.name,
            });
            try {
              const content = fs.readFileSync(localPath);
              await client.writeFile(hdfsPath, content);
              taskManager.complete(taskId);
            } catch (e: any) {
              taskManager.fail(taskId, e.message);
              vscode.window.showErrorMessage(t('msg_uploadFailed', fileName, e.message));
            }
          }
          treeProvider.refresh();
        }
      );
    }),
    vscode.commands.registerCommand('hdfs.download', async (node: any) => {
      if (!node || node.kind !== 'file') return;
      const conn = resolveConnection(node, connectionManager);
      if (!conn) return;
      const client = createClientFromConn(conn);
      const defaultName = node.fullPath.split('/').pop() || 'file';
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(defaultName),
        title: 'Download ' + node.fullPath,
      });
      if (!uri) return;
      const taskId = taskManager.add({
        type: 'download', fileName: defaultName,
        source: node.fullPath, destination: uri.fsPath, connectionName: conn.name,
      });
      try {
        const content = await client.readFile(node.fullPath);
        fs.writeFileSync(uri.fsPath, content);
        taskManager.complete(taskId);
        vscode.window.showInformationMessage(t('msg_downloaded', uri.fsPath));
      } catch (e: any) {
        taskManager.fail(taskId, e.message);
        vscode.window.showErrorMessage(t('msg_downloadFailed', e.message));
      }
    }),
    vscode.commands.registerCommand('hdfs.openFile', async (node: any) => {
      if (!node || !node.fullPath) return;
      const conn = resolveConnection(node, connectionManager);
      if (!conn) return;
      const uri = vscode.Uri.parse('hdfs-file://' + conn.id + node.fullPath);
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (e: any) {
        vscode.window.showErrorMessage('Failed to open file: ' + e.message);
      }
    })
  );
}

function handleOpenConnection(
  connectionManager: ConnectionManager,
  item: HdfsTreeItem,
  jumpHistory: JumpHistory
): void {
  if (!item || !item.connectionId) return;
  const conn = connectionManager.getConnection(item.connectionId);
  if (!conn) return;
  FolderBrowserPanel.create(
    connectionManager, item.connectionId, '', conn.name,
    (id, prefix) => {
      const label = prefix.replace(/\/$/, '').split('/').filter(Boolean).pop() || '/';
      jumpHistory.addRecord(id, prefix, label, conn.name);
    },
    () => jumpHistory.getRecords(),
    false,
    jumpHistory
  );
}

async function handleGoToPath(
  connectionManager: ConnectionManager,
  item: HdfsTreeItem,
  jumpHistory: JumpHistory
): Promise<void> {
  if (!item || !item.connectionId) return;
  const conn = connectionManager.getConnection(item.connectionId);
  if (!conn) return;
  const targetPath = await vscode.window.showInputBox({
    title: t('prompt_goToPath'),
    placeHolder: t('prompt_goToPath_placeholder'),
    ignoreFocusOut: true,
  });
  if (!targetPath) return;
  const segments = targetPath.replace(/\/$/, '').split('/');
  const prefix = targetPath.endsWith('/') ? targetPath : segments.slice(0, -1).join('/') + '/';
  jumpHistory.addRecord(item.connectionId, targetPath, segments[segments.length - 1], conn.name);
  const panel = FolderBrowserPanel.create(
    connectionManager, item.connectionId, prefix, segments[segments.length - 1],
    (id, p) => { jumpHistory.addRecord(id, p, p.split('/').filter(Boolean).pop() || '/', conn.name); },
    () => jumpHistory.getRecords(),
    false,
    jumpHistory
  );
  if (!targetPath.endsWith('/')) {
    await panel.goToPath(targetPath);
  }
}

async function deleteConnection(
  connectionManager: ConnectionManager,
  treeProvider: HdfsTreeDataProvider,
  item: HdfsTreeItem
): Promise<void> {
  if (!item || !item.connectionId) return;
  const conn = connectionManager.getConnection(item.connectionId);
  if (!conn) return;
  const confirmed = await vscode.window.showWarningMessage(
    t('msg_removeConfirm', conn.name),
    { modal: true },
    t('msg_removeBtn')
  );
  if (confirmed !== t('msg_removeBtn')) return;
  await connectionManager.removeConnection(item.connectionId);
  treeProvider.refresh();
}

async function handleKinit(connectionManager: ConnectionManager): Promise<void> {
  const principal = await vscode.window.showInputBox({
    prompt: 'Kerberos principal',
    placeHolder: 'user@REALM',
  });
  const keytab = await vscode.window.showInputBox({
    prompt: 'Path to keytab file (optional)',
    placeHolder: '/etc/krb5.keytab',
  });
  try {
    const { HdfsClient } = require('./hdfsClient');
    const firstConn = connectionManager.connections[0];
    if (!firstConn) throw new Error('No connection configured');
    const client = new HdfsClient({
      protocol: firstConn.protocol, host: firstConn.host, port: firstConn.port,
      authMethod: 'KERBEROS', username: '',
      curlPath: firstConn.curlPath || 'curl', insecure: firstConn.insecure,
    });
    await client.kinit(principal || undefined, keytab || undefined);
    vscode.window.showInformationMessage(t('msg_kinitSuccess'));
  } catch (e: any) {
    vscode.window.showErrorMessage(t('msg_kinitFailed', e.message));
  }
}

function resolveConnection(node: any, connectionManager: ConnectionManager): HdfsConnection | undefined {
  if (!node) return undefined;
  if (node.connectionId) return connectionManager.getConnection(node.connectionId);
  if (node.connectionId_) return connectionManager.getConnection(node.connectionId_);
  if (node.connection) return node.connection;
  return undefined;
}

function createClientFromConn(conn: HdfsConnection): HdfsClient {
  return new HdfsClient({
    protocol: conn.protocol, host: conn.host, port: conn.port,
    authMethod: conn.authMethod, username: conn.username,
    curlPath: vscode.workspace.getConfiguration('hdfs').get<string>('curl.path', conn.curlPath || 'curl'),
    principal: conn.principal || undefined,
    keytabPath: conn.keytabPath || undefined,
    realm: conn.realm || undefined,
    kdc: conn.kdc || undefined,
    insecure: conn.insecure,
    delegationToken: conn.delegationToken || undefined,
  });
}
