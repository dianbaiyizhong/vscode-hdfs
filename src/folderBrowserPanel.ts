import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ConnectionManager, HdfsConnection } from './connectionManager';
import { HdfsClient, FileStatus } from './hdfsClient';
import { taskManager } from './taskManager';
import { TaskViewPanel } from './taskViewPanel';
import { JumpHistory, JumpRecord } from './jumpHistory';
import { t } from './i18n';

interface HdfsItem {
  pathSuffix: string;
  type: 'FILE' | 'DIRECTORY';
  length: number;
  modificationTime: number;
  permission: string;
  owner: string;
  group: string;
  fullPath: string;
}

export class FolderBrowserPanel {
  public static extensionUri: vscode.Uri | undefined;
  private static _iconsLoaded = false;
  private static folderSvg = '';
  private static fileSvg = '';
  private static actionIcons: Record<string, string> = {};
  private static backSvg = '';

  private static loadIcons(): void {
    if (FolderBrowserPanel._iconsLoaded) return;
    FolderBrowserPanel._iconsLoaded = true;
    const extPath = vscode.extensions.getExtension('nntk.vscode-hdfs')?.extensionPath;
    if (!extPath) return;
    const resDir = path.join(extPath, 'resources');
    const actDir = path.join(resDir, 'action-icons');
    FolderBrowserPanel.folderSvg = readSvg(path.join(resDir, 'folder.svg'));
    FolderBrowserPanel.fileSvg = readSvg(path.join(resDir, 'file.svg'));
    FolderBrowserPanel.backSvg = readSvg(path.join(actDir, 'back.svg')) || '&#x2190;';
    const iconNames = ['refresh', 'newfolder', 'upload', 'bookmark', 'taskview', 'download', 'delete', 'info', 'rename', 'copypath', 'copyfilename'];
    for (const name of iconNames) {
      FolderBrowserPanel.actionIcons[name] = readSvg(path.join(actDir, name + '.svg'));
    }
  }

  public static create(
    connectionManager: ConnectionManager,
    connectionId: string,
    prefix: string,
    label: string,
    onNavigate: (connectionId: string, prefix: string) => void,
    getHistoryRecords?: () => JumpRecord[],
    skipInitialLoad = false,
    jumpHistory?: JumpHistory,
  ): FolderBrowserPanel {
    TaskViewPanel.currentPanel?.dispose();
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    return new FolderBrowserPanel(column, connectionManager, connectionId, prefix, label, onNavigate, getHistoryRecords, skipInitialLoad, jumpHistory);
  }

  private panel: vscode.WebviewPanel;
  private connectionId: string;
  private prefix: string;
  private connectionName: string;
  private getHistoryRecords: (() => JumpRecord[]) | undefined;
  private items: HdfsItem[] = [];
  private loading = false;
  private refreshing = false;
  private searchPattern?: string;
  private jumpHistory?: JumpHistory;

  private constructor(
    column: vscode.ViewColumn,
    private connectionManager: ConnectionManager,
    connectionId: string,
    prefix: string,
    label: string,
    private onNavigate: (connectionId: string, prefix: string) => void,
    getHistoryRecords?: () => JumpRecord[],
    skipInitialLoad = false,
    jumpHistory?: JumpHistory,
  ) {
    this.connectionId = connectionId;
    this.prefix = prefix;
    this.getHistoryRecords = getHistoryRecords;
    this.jumpHistory = jumpHistory;
    FolderBrowserPanel.loadIcons();
    const conn = connectionManager.getConnection(connectionId);
    this.connectionName = conn?.name || label;

    const initPath = (prefix || '/').length > 15 ? '…' + (prefix || '/').slice(-15) : (prefix || '/');
    this.panel = vscode.window.createWebviewPanel(
      'folderBrowser',
      `${initPath} — ${this.connectionName}`,
      column,
      { enableScripts: true }
    );
    this.panel.iconPath = FolderBrowserPanel.extensionUri
      ? vscode.Uri.joinPath(FolderBrowserPanel.extensionUri, 'resources', 'action-icons', 'window.svg')
      : new vscode.ThemeIcon('window');

    if (!skipInitialLoad) {
      this.loadItems().then(() => this.render());
    } else {
      this.render();
    }

    this.panel.webview.onDidReceiveMessage(async message => {
      switch (message.type) {
        case 'navigate':
          this.searchPattern = undefined;
          this.prefix = message.prefix;
          this.items = [];
          this.loading = false;
          this.render();
          this.onNavigate(this.connectionId, message.prefix);
          await this.loadItems();
          this.render();
          break;
        case 'navigateUp': {
          this.searchPattern = undefined;
          const parent = this.getParentPrefix();
          this.prefix = parent;
          this.items = [];
          this.loading = false;
          this.render();
          this.onNavigate(this.connectionId, parent);
          await this.loadItems();
          this.render();
          break;
        }
        case 'goToPath': {
          const rawPath = message.path as string || '';
          if (!rawPath) break;
          await this.goToPath(rawPath);
          break;
        }
        case 'historyJump': {
          const conn = this.connectionManager.getConnection(message.connectionId as string);
          if (!conn) { vscode.window.showErrorMessage(t('msg_noConnection')); break; }
          await this.goToPath(message.key as string);
          break;
        }
        case 'delete': {
          await this.handleDelete(message.item);
          break;
        }
        case 'rename': {
          await this.handleRename(message.item);
          break;
        }
        case 'deleteSelected': {
          await this.handleDeleteSelected(message.items);
          break;
        }
        case 'downloadSelected': {
          await this.handleDownloadSelected(message.items);
          break;
        }
        case 'copyPath': {
          const item = message.item as HdfsItem;
          vscode.env.clipboard.writeText(item.fullPath);
          vscode.window.setStatusBarMessage(`$(link) ${t('msg_pathCopied')}`, 3000);
          break;
        }
        case 'copyFileName': {
          const item = message.item as HdfsItem;
          vscode.env.clipboard.writeText(item.pathSuffix);
          vscode.window.setStatusBarMessage(`$(link) ${t('msg_fileNameCopied')}`, 3000);
          break;
        }
        case 'info': {
          await this.handleInfo(message.item);
          break;
        }
        case 'download': {
          await this.handleDownload(message.item);
          break;
        }
        case 'refresh':
          this.searchPattern = undefined;
          this.refreshing = true;
          this.loading = false;
          this.items = [];
          this.render();
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: t('msg_refreshing') },
            () => this.loadItems()
          );
          this.refreshing = false;
          this.render();
          break;
        case 'newFolder': {
          await this.handleNewFolder();
          break;
        }
        case 'upload': {
          await this.handleUpload();
          break;
        }
        case 'searchFiles': {
          const pattern = message.pattern as string;
          if (!pattern) break;
          this.searchPattern = pattern;
          this.items = [];
          this.render();
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: pattern },
            async () => {
              await this.loadAllSearchPages();
            }
          );
          if (this.items.length === 0) {
            vscode.window.showInformationMessage(`No results for "${pattern}"`);
          }
          this.render();
          break;
        }
        case 'showError':
          vscode.window.showErrorMessage(message.text);
          break;
        case 'uploadDrop': {
          await this.handleUploadDrop(message.files);
          break;
        }
        case 'openTaskView': {
          TaskViewPanel.createOrShow();
          break;
        }
        case 'toggleBookmark': {
          if (!this.jumpHistory) break;
          const connBM = this.connectionManager.getConnection(this.connectionId);
          if (!connBM) break;
          const itemBM = message.item as HdfsItem;
          const nowBookmarked = this.jumpHistory.toggleBookmark(this.connectionId, itemBM.fullPath);
          vscode.window.showInformationMessage(nowBookmarked
            ? t('msg_bookmarkAdded', itemBM.pathSuffix)
            : t('msg_bookmarkRemoved'));
          break;
        }
        case 'showBookmarks': {
          if (!this.jumpHistory) break;
          const bms = this.jumpHistory.getBookmarks().filter(b => b.connectionId === this.connectionId);
          if (bms.length === 0) {
            vscode.window.showInformationMessage(t('msg_noBookmarks'));
            break;
          }
          const picks = bms.map(b => ({
            label: b.label || b.key.split('/').filter(Boolean).pop() || b.key,
            description: b.key,
            key: b.key,
          }));
          const pick = await vscode.window.showQuickPick(picks, {
            title: t('msg_bookmarks'),
            matchOnDescription: true,
          });
          if (!pick) break;
          await this.goToPath(pick.key);
          break;
        }
      }
    });
  }

  public async goToPath(rawPath: string): Promise<void> {
    this.searchPattern = undefined;
    const conn = this.connectionManager.getConnection(this.connectionId);
    if (!conn || !rawPath) return;

    if (rawPath === '/') {
      this.prefix = '';
      this.items = [];
      this.loading = false;
      this.onNavigate(this.connectionId, '');
      this.render();
      await this.loadItems();
      this.render();
      return;
    }

    const trimmed = rawPath.replace(/\/$/, '');
    const isFolderInput = rawPath.endsWith('/');
    const lastSlash = trimmed.lastIndexOf('/');
    const parentPrefix = lastSlash === -1 ? '' : trimmed.substring(0, lastSlash + 1);
    const client = this.getClient(conn);

    let fileExists = false;
    if (!isFolderInput) {
      try {
        await client.getFileStatus(trimmed);
        fileExists = true;
      } catch { /* file doesn't exist */ }
    }

    if (fileExists) {
      this.prefix = parentPrefix;
      this.items = [];
      this.loading = false;
      this.onNavigate(this.connectionId, rawPath);
      this.render();
      await this.loadItems();
      // Add the file if it was a direct file path
      if (fileExists) {
        try {
          const fs = await client.getFileStatus(trimmed);
          const fileItem: HdfsItem = {
            pathSuffix: trimmed.split('/').pop() || '',
            type: 'FILE',
            length: fs.length,
            modificationTime: fs.modificationTime,
            permission: fs.permission,
            owner: fs.owner,
            group: fs.group,
            fullPath: trimmed,
          };
          this.items = [fileItem, ...this.items.filter(i => i.type === 'DIRECTORY')];
        } catch { /* ignore */ }
      }
      this.render();
    } else {
      // Try as folder
      this.prefix = trimmed + '/';
      this.items = [];
      this.loading = false;
      this.onNavigate(this.connectionId, this.prefix);
      this.render();
      await this.loadItems();
      if (this.items.length === 0 && trimmed !== '/') {
        this.prefix = parentPrefix;
        this.items = [];
        this.loading = false;
        this.onNavigate(this.connectionId, parentPrefix);
        this.render();
        await this.loadItems();
        this.render();
        vscode.window.showWarningMessage(t('msg_pathNotFound', rawPath));
      } else {
        this.render();
      }
    }
  }

  private getParentPrefix(): string {
    if (!this.prefix) return '';
    const trimmed = this.prefix.replace(/\/$/, '');
    const lastSlash = trimmed.lastIndexOf('/');
    if (lastSlash === -1) return '';
    return trimmed.substring(0, lastSlash + 1);
  }

  private getClient(conn: HdfsConnection): HdfsClient {
    return new HdfsClient({
      protocol: conn.protocol,
      host: conn.host,
      port: conn.port,
      authMethod: conn.authMethod,
      username: conn.username,
      curlPath: vscode.workspace.getConfiguration('hdfs').get<string>('curl.path', conn.curlPath || 'curl'),
      principal: conn.principal || undefined,
      keytabPath: conn.keytabPath || undefined,
      realm: conn.realm || undefined,
      kdc: conn.kdc || undefined,
      insecure: conn.insecure,
      delegationToken: conn.delegationToken || undefined,
    });
  }

  private async loadItems(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      const conn = this.connectionManager.getConnection(this.connectionId);
      if (!conn) return;
      const client = this.getClient(conn);
      const path = this.prefix || '/';
      const files = await client.listStatus(path);
      this.items = files
        .filter(f => !f.pathSuffix.startsWith('_') && !f.pathSuffix.startsWith('.'))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === 'DIRECTORY' ? -1 : 1;
          return a.pathSuffix.localeCompare(b.pathSuffix);
        })
        .map(f => ({
          pathSuffix: f.pathSuffix,
          type: f.type,
          length: f.length,
          modificationTime: f.modificationTime,
          permission: f.permission,
          owner: f.owner,
          group: f.group,
          fullPath: path === '/' ? '/' + f.pathSuffix : (path.endsWith('/') ? path : path + '/') + f.pathSuffix,
        }));
    } finally {
      this.loading = false;
    }
  }

  private async loadAllSearchPages(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      const conn = this.connectionManager.getConnection(this.connectionId);
      if (!conn) return;
      const client = this.getClient(conn);
      const path = this.prefix || '/';
      const files = await client.listStatus(path);
      const lower = this.searchPattern!.toLowerCase();
      this.items = files
        .filter(f => !f.pathSuffix.startsWith('_') && !f.pathSuffix.startsWith('.'))
        .filter(f => f.pathSuffix.toLowerCase().includes(lower))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === 'DIRECTORY' ? -1 : 1;
          return a.pathSuffix.localeCompare(b.pathSuffix);
        })
        .map(f => ({
          pathSuffix: f.pathSuffix,
          type: f.type,
          length: f.length,
          modificationTime: f.modificationTime,
          permission: f.permission,
          owner: f.owner,
          group: f.group,
          fullPath: path === '/' ? '/' + f.pathSuffix : (path.endsWith('/') ? path : path + '/') + f.pathSuffix,
        }));
    } finally {
      this.loading = false;
    }
  }

  private async handleDelete(item: HdfsItem): Promise<void> {
    const conn = this.connectionManager.getConnection(this.connectionId);
    if (!conn) return;
    const deleteBtn = t('msg_deleteBtn');
    const msgKey = item.type === 'DIRECTORY' ? 'msg_deleteFolderConfirm' : 'msg_deleteConfirm';
    const confirmed = await vscode.window.showWarningMessage(
      t(msgKey, item.pathSuffix),
      { modal: true },
      deleteBtn
    );
    if (confirmed !== deleteBtn) return;
    const client = this.getClient(conn);
    await client.delete(item.fullPath, item.type === 'DIRECTORY');
    this.items = this.items.filter(i => i.fullPath !== item.fullPath);
    this.render();
  }

  private async handleRename(item: HdfsItem): Promise<void> {
    const conn = this.connectionManager.getConnection(this.connectionId);
    if (!conn) return;
    const newName = await vscode.window.showInputBox({
      title: t(item.type === 'DIRECTORY' ? 'prompt_rename_folder' : 'prompt_rename_file'),
      value: item.pathSuffix,
      ignoreFocusOut: true,
    });
    if (!newName || newName === item.pathSuffix) return;
    const parent = item.fullPath.substring(0, item.fullPath.lastIndexOf('/')) || '';
    const newPath = parent ? parent + '/' + newName : '/' + newName;
    const client = this.getClient(conn);
    try {
      await client.rename(item.fullPath, newPath);
      this.items = [];
      this.loading = false;
      await this.loadItems();
      this.render();
    } catch (err: any) {
      vscode.window.showErrorMessage(t('msg_renameFailed', err.message));
    }
  }

  private async handleDeleteSelected(items: { fullPath: string; type: string }[]): Promise<void> {
    const conn = this.connectionManager.getConnection(this.connectionId);
    if (!conn || !items || items.length === 0) return;
    const deleteBtn = t('msg_deleteBtn');
    const confirmed = await vscode.window.showWarningMessage(
      `Delete ${items.length} selected item(s)?`,
      { modal: true },
      deleteBtn
    );
    if (confirmed !== deleteBtn) return;
    const client = this.getClient(conn);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('msg_deleting', items.length) },
      async (progress) => {
        for (let i = 0; i < items.length; i++) {
          progress.report({ message: `${i + 1}/${items.length}` });
          try {
            await client.delete(items[i].fullPath, items[i].type === 'DIRECTORY');
          } catch { /* skip failures */ }
        }
      }
    );
    this.items = [];
    this.loading = false;
    await this.loadItems();
    this.render();
  }

  private async handleDownloadSelected(items: { fullPath: string; type: string; length: number; pathSuffix: string }[]): Promise<void> {
    const conn = this.connectionManager.getConnection(this.connectionId);
    if (!conn || !items || items.length === 0) return;
    const files = items.filter(i => i.type === 'FILE');
    if (files.length === 0) {
      vscode.window.showInformationMessage('No files selected (folders are skipped)');
      return;
    }
    const uris = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectMany: false,
      title: `Select destination for ${files.length} files`,
    });
    if (!uris || uris.length === 0) return;
    const destDir = uris[0].fsPath;
    const client = this.getClient(conn);
    let successCount = 0;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Downloading ${files.length} files...` },
      async (progress) => {
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          progress.report({ message: `${i + 1}/${files.length} ${f.pathSuffix}` });
          try {
            const content = await client.readFile(f.fullPath);
            fs.writeFileSync(path.join(destDir, f.pathSuffix), content);
            successCount++;
          } catch (err: any) {
            vscode.window.showErrorMessage(t('msg_downloadFailed', `${f.pathSuffix}: ${err.message}`));
          }
        }
      }
    );
    if (successCount > 0) {
      vscode.window.showInformationMessage(`Downloaded ${successCount} file(s) to ${destDir}`);
    }
  }

  private async handleDownload(item: HdfsItem): Promise<void> {
    const conn = this.connectionManager.getConnection(this.connectionId);
    if (!conn) return;
    const client = this.getClient(conn);
    if (item.type === 'DIRECTORY') {
      vscode.window.showInformationMessage('Folder download not supported yet. Use the tree view.');
      return;
    }
    const defaultUri = vscode.Uri.file(item.pathSuffix);
    const uri = await vscode.window.showSaveDialog({ defaultUri });
    if (!uri) return;
    const taskId = taskManager.add({
      type: 'download', fileName: item.pathSuffix, size: item.length,
      source: item.fullPath, destination: uri.fsPath, connectionName: conn.name,
    });
    try {
      const content = await client.readFile(item.fullPath);
      fs.writeFileSync(uri.fsPath, content);
      taskManager.complete(taskId);
      vscode.window.showInformationMessage(t('msg_downloaded', uri.fsPath));
    } catch (err: any) {
      taskManager.fail(taskId, err.message);
      vscode.window.showErrorMessage(t('msg_downloadFailed', err.message));
    }
  }

  private async handleInfo(item: HdfsItem): Promise<void> {
    const conn = this.connectionManager.getConnection(this.connectionId);
    if (!conn) return;
    const infoItems: { label: string; value: string }[] = [
      { label: 'Path', value: item.fullPath },
      { label: 'Type', value: item.type === 'DIRECTORY' ? 'Folder' : 'File' },
      { label: 'Size', value: formatSize(item.length) },
      { label: 'Owner', value: item.owner },
      { label: 'Group', value: item.group },
      { label: 'Permission', value: item.permission },
      { label: 'Modified', value: formatDate(new Date(item.modificationTime)) },
      { label: 'Replication', value: String(item.length > 0 ? 3 : 0) },
    ];
    const picks = infoItems.map(i => ({ label: i.label, description: i.value }));
    const pick = await vscode.window.showQuickPick(picks, {
      title: `Info: ${item.pathSuffix}`,
      placeHolder: 'Click to copy value',
      matchOnDescription: true,
    });
    if (pick) {
      vscode.env.clipboard.writeText(pick.description || '');
      vscode.window.setStatusBarMessage(`$(link) ${t('msg_pathCopied')}`, 2000);
    }
  }

  private async handleNewFolder(): Promise<void> {
    const conn = this.connectionManager.getConnection(this.connectionId);
    if (!conn) return;
    const folderName = await vscode.window.showInputBox({
      title: t('prompt_newFolderName'),
      placeHolder: t('prompt_newFolder_placeholder'),
      ignoreFocusOut: true,
      validateInput: (val) => {
        if (!val) return t('val_empty');
        if (val.includes('/')) return t('val_slash');
        return undefined;
      },
    });
    if (!folderName) return;
    const client = this.getClient(conn);
    const newPath = (this.prefix || '/') + folderName;
    try {
      await client.mkdirs(newPath);
      this.items = [];
      this.loading = false;
      await this.loadItems();
      this.render();
      vscode.window.showInformationMessage(t('msg_folderCreated', folderName));
    } catch (err: any) {
      vscode.window.showErrorMessage(t('msg_folderFailed', err.message));
    }
  }

  private async handleUpload(): Promise<void> {
    const conn = this.connectionManager.getConnection(this.connectionId);
    if (!conn) return;
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      title: `Upload to ${this.prefix || '/'}`,
    });
    if (!uris || uris.length === 0) return;
    const client = this.getClient(conn);
    let successCount = 0;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: t('msg_uploading', uris.length) },
      async (progress) => {
        for (let i = 0; i < uris.length; i++) {
          const localPath = uris[i].fsPath;
          const fileName = path.basename(localPath);
          const hdfsPath = (this.prefix || '/') + fileName;
          progress.report({ message: `${fileName} (${i + 1}/${uris.length})` });
          const taskId = taskManager.add({
            type: 'upload', fileName, size: fs.statSync(localPath).size,
            source: localPath, destination: hdfsPath, connectionName: conn.name,
          });
          try {
            const content = fs.readFileSync(localPath);
            await client.writeFile(hdfsPath, content);
            taskManager.complete(taskId);
            successCount++;
          } catch (err: any) {
            taskManager.fail(taskId, err.message);
            vscode.window.showErrorMessage(t('msg_uploadFailed', fileName, err.message));
          }
        }
      }
    );
    if (successCount > 0) {
      this.items = [];
      this.loading = false;
      await this.loadItems();
      this.render();
      vscode.window.showInformationMessage(t('msg_uploaded', successCount));
    }
  }

  private async handleUploadDrop(files: { fileName: string; content: string }[]): Promise<void> {
    const conn = this.connectionManager.getConnection(this.connectionId);
    if (!conn || !files || files.length === 0) return;
    const client = this.getClient(conn);
    let successCount = 0;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: t('msg_uploading', files.length) },
      async (progress) => {
        for (let i = 0; i < files.length; i++) {
          const { fileName, content } = files[i];
          const key = (this.prefix || '/') + fileName;
          progress.report({ message: `${i + 1}/${files.length} ${fileName}` });
          const taskId = taskManager.add({
            type: 'upload', fileName, source: key,
            destination: key, connectionName: conn.name,
          });
          try {
            const buffer = Buffer.from(content, 'base64');
            await client.writeFile(key, buffer);
            taskManager.complete(taskId);
            successCount++;
          } catch (err: any) {
            taskManager.fail(taskId, err.message);
          }
        }
      }
    );
    if (successCount > 0) {
      this.items = [];
      this.loading = false;
      await this.loadItems();
      this.render();
    }
  }

  private render(): void {
    const displayPath = this.prefix || '/';
    this.panel.title = `${this.searchPattern ? this.searchPattern : displayPath} — ${this.connectionName}`;
    const records = this.getHistoryRecords?.() || [];
    const bmKeys = new Set<string>();
    if (this.jumpHistory) {
      for (const bm of this.jumpHistory.getBookmarks()) {
        if (bm.connectionId === this.connectionId) bmKeys.add(bm.key);
      }
    }
    this.panel.webview.html = getHtml(
      displayPath,
      this.items,
      this.loading || this.refreshing,
      this.searchPattern,
      records,
      this.connectionId,
      bmKeys,
      FolderBrowserPanel.folderSvg,
      FolderBrowserPanel.fileSvg,
      FolderBrowserPanel.actionIcons,
      FolderBrowserPanel.backSvg,
    );
  }
}

function readSvg(p: string): string {
  try { return fs.readFileSync(p, 'utf-8'); } catch { return ''; }
}

function formatSize(bytes?: number): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDate(date?: Date): string {
  if (!date) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function svgAction(icon: string, alt: string): string {
  return icon || `<!--${alt}-->`;
}

function getHtml(
  prefix: string,
  items: HdfsItem[],
  loading: boolean,
  searchPattern?: string,
  historyRecords?: JumpRecord[],
  connectionId?: string,
  bookmarkedKeys?: Set<string>,
  folderSvg = '',
  fileSvg = '',
  actionIcons: Record<string, string> = {},
  backSvg = '',
): string {
  const folderRows = items.filter(i => i.type === 'DIRECTORY').map(i => {
    const data = JSON.stringify(i).replace(/"/g, '&quot;');
    const bm = bookmarkedKeys?.has(i.fullPath) ? ' data-bookmarked="1"' : '';
    return `<div class="item folder" data-item="${data}"${bm}>
      <input type="checkbox" class="item-cb">
      <span class="item-icon">${folderSvg}</span>
      <span class="item-name">${escapeHtml(i.pathSuffix)}</span>
      <span class="item-meta"></span>
      <span class="item-date">${formatDate(new Date(i.modificationTime))}</span>
      <span class="item-actions">
        <span class="action" data-action="info" title="${t('wv_info')}">${svgAction(actionIcons['info'], 'Info')}</span>
        <span class="action" data-action="rename" title="${t('wv_rename')}">${svgAction(actionIcons['rename'], 'Rename')}</span>
        <span class="action" data-action="delete" title="${t('wv_delete')}">${svgAction(actionIcons['delete'], 'Delete')}</span>
        <span class="action" data-action="copyPath" title="${t('wv_copyPath')}">${svgAction(actionIcons['copypath'], 'Copy Path')}</span>
        <span class="action" data-action="copyFileName" title="${t('wv_copyFileName')}">${svgAction(actionIcons['copyfilename'], 'Copy File Name')}</span>
      </span>
    </div>`;
  }).join('');

  const fileRows = items.filter(i => i.type === 'FILE').map(i => {
    const data = JSON.stringify(i).replace(/"/g, '&quot;');
    const bm = bookmarkedKeys?.has(i.fullPath) ? ' data-bookmarked="1"' : '';
    return `<div class="item file" data-item="${data}"${bm}>
      <input type="checkbox" class="item-cb">
      <span class="item-icon">${fileSvg}</span>
      <span class="item-name">${escapeHtml(i.pathSuffix)}</span>
      <span class="item-meta">${formatSize(i.length)}</span>
      <span class="item-date">${formatDate(new Date(i.modificationTime))}</span>
      <span class="item-actions">
        <span class="action" data-action="info" title="${t('wv_info')}">${svgAction(actionIcons['info'], 'Info')}</span>
        <span class="action" data-action="rename" title="${t('wv_rename')}">${svgAction(actionIcons['rename'], 'Rename')}</span>
        <span class="action" data-action="download" title="${t('wv_download')}">${svgAction(actionIcons['download'], 'Download')}</span>
        <span class="action" data-action="delete" title="${t('wv_delete')}">${svgAction(actionIcons['delete'], 'Delete')}</span>
        <span class="action" data-action="copyPath" title="${t('wv_copyPath')}">${svgAction(actionIcons['copypath'], 'Copy Path')}</span>
        <span class="action" data-action="copyFileName" title="${t('wv_copyFileName')}">${svgAction(actionIcons['copyfilename'], 'Copy File Name')}</span>
      </span>
    </div>`;
  }).join('');

  const allRows = folderRows + fileRows;
  const emptyState = !allRows && !loading
    ? `<div class="empty">${t('wv_empty')}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
* { box-sizing: border-box; }
body {
  margin: 0; padding: 0;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  display: flex; flex-direction: column; height: 100vh; overflow: hidden;
}
.top-section { padding: 12px 16px 0 16px; flex-shrink: 0; }
.content-section { flex: 1; overflow-y: auto; overflow-x: hidden; scrollbar-gutter: stable; padding: 0 16px 12px 16px; }
.header {
  display: flex; align-items: center; gap: 8px;
  margin-bottom: 12px; padding-bottom: 10px; border-bottom: 1px solid var(--vscode-panel-border);
}
.back-btn {
  background: none; border: none; color: var(--vscode-textLink-foreground);
  cursor: pointer; padding: 2px 6px; border-radius: 4px; display: flex; align-items: center;
}
.back-btn:hover { background: var(--vscode-list-hoverBackground); }
.back-btn:disabled { opacity: 0.3; cursor: default; }
.path-input {
  flex: 1; font-size: 15px; font-weight: 600; background: transparent;
  border: 1px solid transparent; color: var(--vscode-foreground);
  padding: 2px 6px; border-radius: 3px; outline: none; min-width: 0;
}
.path-input:focus { border-color: var(--vscode-focusBorder); background: var(--vscode-input-background); }
.icon-btn {
  background: none; border: none; color: var(--vscode-foreground);
  cursor: pointer; padding: 2px 6px; border-radius: 3px; opacity: 0.7;
  display: flex; align-items: center; position: relative; font-size: 14px;
}
.icon-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
.icon-btn:disabled { opacity: 0.3; cursor: default; }
.header-sep { width: 1px; height: 18px; background: var(--vscode-panel-border); margin: 0 4px; flex-shrink: 0; }
.filter-input {
  width: 100%; padding: 5px 8px; margin-bottom: 8px;
  background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border); border-radius: 3px;
  font-size: 13px; outline: none; box-sizing: border-box;
}
.filter-input:focus { border-color: var(--vscode-focusBorder); }
.empty { text-align: center; margin-top: 48px; color: var(--vscode-descriptionForeground); }
.list-header, .item {
  display: grid;
  grid-template-columns: 28px 24px 1fr 90px 140px 120px;
  align-items: center; gap: 6px; padding: 4px 8px; border-radius: 3px;
}
.list-header {
  font-size: 11px; font-weight: 600; color: var(--vscode-descriptionForeground);
  border-bottom: 1px solid var(--vscode-panel-border);
  margin-bottom: 4px; padding-bottom: 4px; user-select: none;
}
.list-header > span { cursor: pointer; }
.list-header > span:hover { color: var(--vscode-foreground); }
.item { cursor: default; border: 1px solid transparent; transition: background 0.1s; }
.item:hover { background: var(--vscode-list-hoverBackground); }
.item.selected { background: var(--vscode-list-inactiveSelectionBackground); }
.item.folder { cursor: pointer; }
.item-cb { width: 14px; height: 14px; cursor: pointer; accent-color: var(--vscode-focusBorder); }
.item-icon { width:20px; height:20px; display:flex; align-items:center; justify-content:center; }
.item-icon svg { width:20px; height:20px; }
.item-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item-meta { font-size: 11px; color: var(--vscode-descriptionForeground); text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.item-date { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.item-actions { display: flex; gap: 2px; opacity: 0; }
.item:hover .item-actions { opacity: 1; }
.action {
  display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; border-radius: 3px; cursor: pointer;
  line-height:0; opacity: 0.7; transition: opacity 0.1s, background 0.1s; position: relative;
}
.action svg { width:16px; height:16px; }
.icon-btn svg { width:18px; height:18px; display:block; }
.back-btn svg { width:18px; height:18px; display:block; }
.action:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
.action::after {
  content: attr(title); position: absolute; bottom: -28px; left: 50%;
  transform: translateX(-50%);
  background: var(--vscode-editorWidget-background, #333);
  color: var(--vscode-editorWidget-foreground, #fff);
  font-size: 11px; padding: 2px 6px; border-radius: 3px;
  white-space: nowrap; pointer-events: none; opacity: 0;
  transition: opacity 0.15s; z-index: 999;
}
.action:hover::after { opacity: 1; }
.drag-overlay {
  display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0;
  border: 3px dashed var(--vscode-focusBorder);
  background: var(--vscode-editor-background); opacity: 0.85;
  align-items: center; justify-content: center;
  font-size: 18px; font-weight: 600; z-index: 999;
}
.drag-overlay.show { display: flex; }
.history-dropdown {
  display: none; position: absolute; top: 100%; left: 0; right: 0; z-index: 100;
  max-height: 300px; overflow-y: auto;
  background: var(--vscode-dropdown-background, var(--vscode-menu-background));
  border: 1px solid var(--vscode-dropdown-border, var(--vscode-menu-border));
  border-radius: 4px; box-shadow: 0 4px 12px rgba(0,0,0,0.25); margin-top: 2px;
}
.history-dropdown.show { display: block; }
.history-item {
  padding: 7px 12px; cursor: pointer;
  border-bottom: 1px solid var(--vscode-dropdown-border, transparent);
}
.history-item:last-child { border-bottom: none; }
.history-item:hover, .history-item.active {
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
}
.history-item .hi-path { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.history-item .hi-conn { font-size: 11px; opacity: 0.7; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.header { position: relative; }
</style>
</head>
<body>
<div class="drag-overlay" id="dragOverlay">${t('wv_dropUpload')}</div>
<div class="top-section">
<div class="header">
  <button class="back-btn" id="backBtn" ${!prefix || prefix === '/' ? 'disabled' : ''}>${backSvg}</button>
  <input class="path-input" id="pathInput" value="${escapeHtml(prefix)}" title="${t('wv_pathInputTitle')}" autofocus>
  <button class="icon-btn" id="refreshBtn" title="${t('wv_refresh')}" ${loading ? 'disabled' : ''}>${svgAction(actionIcons['refresh'], 'Refresh')}</button>
  <button class="icon-btn" id="newFolderBtn" title="${t('cmd_newFolder')}">${svgAction(actionIcons['newfolder'], 'New Folder')}</button>
  <button class="icon-btn" id="uploadBtn" title="${t('wv_upload')}">${svgAction(actionIcons['upload'], 'Upload')}</button>
  <button class="icon-btn" id="bookmarkBtn" title="${t('msg_bookmarks')}">${svgAction(actionIcons['bookmark'], 'Bookmark')}</button>
  <button class="icon-btn" id="taskViewBtn" title="${t('cmd_openTaskView')}">${svgAction(actionIcons['taskview'], 'Tasks')}</button>
  <span class="header-sep"></span>
  <button class="icon-btn" id="dlBatchBtn" title="${t('wv_downloadSelected')}" disabled>${svgAction(actionIcons['download'], 'Download')}</button>
  <button class="icon-btn" id="delBatchBtn" title="${t('wv_deleteSelected')}" disabled>${svgAction(actionIcons['delete'], 'Delete')}</button>
  <div class="history-dropdown" id="historyDropdown"></div>
</div>
<input class="filter-input" id="filterInput" type="text" placeholder="${t('wv_filterPlaceholder')}" value="${searchPattern ? escapeHtml(searchPattern) : ''}"${searchPattern ? ' data-searching="1"' : ''} autocomplete="off">
<div class="list-header">
  <span></span><span></span>
  <span onclick="sortBy('name')">${t('wv_name')}<span class="sort-icon"></span></span>
  <span onclick="sortBy('size')">${t('wv_size')}<span class="sort-icon"></span></span>
  <span onclick="sortBy('date')">${t('wv_modified')}<span class="sort-icon"></span></span>
  <span>${t('wv_actions')}</span>
</div>
</div>
<div class="content-section" id="contentSection">
${emptyState}
${allRows}
</div>
<script>
const vscodeApi = acquireVsCodeApi();
const l10n = ${JSON.stringify({
    bookmark: t('wv_bookmark'), bookmarked: t('wv_bookmarked'),
    unbookmark: t('wv_unbookmark'), bookmarks: t('msg_bookmarks'),
    noBookmarks: t('msg_noBookmarks'), info: t('wv_info'),
    rename: t('wv_rename'), delete: t('wv_delete'),
    copyPath: t('wv_copyPath'), copyFileName: t('wv_copyFileName'),
    download: t('wv_download'), newFolder: t('cmd_newFolder'),
})};

let sortCol = '';
let sortDir = 1;
function sortBy(col) {
  if (sortCol === col) sortDir *= -1; else { sortCol = col; sortDir = 1; }
  const container = document.getElementById('contentSection');
  const items = Array.from(document.querySelectorAll('.item'));
  const headers = document.querySelectorAll('.list-header .sort-icon');
  headers.forEach(h => h.textContent = '');
  const idx = ['name','size','date'].indexOf(col) + 2;
  const activeHeader = document.querySelectorAll('.list-header > span')[idx];
  if (activeHeader) activeHeader.querySelector('.sort-icon').textContent = sortDir > 0 ? '▲' : '▼';
  items.sort((a, b) => {
    const va = JSON.parse(a.dataset.item);
    const vb = JSON.parse(b.dataset.item);
    let cmp = 0;
    if (col === 'name') cmp = va.pathSuffix.localeCompare(vb.pathSuffix);
    else if (col === 'size') cmp = (va.length || 0) - (vb.length || 0);
    else if (col === 'date') cmp = (va.modificationTime||0) - (vb.modificationTime||0);
    return cmp * sortDir;
  });
  items.forEach(el => container.appendChild(el));
}

const dlBatchBtn = document.getElementById('dlBatchBtn');
const delBatchBtn = document.getElementById('delBatchBtn');
function getSelectedItems() {
  return Array.from(document.querySelectorAll('.item-cb:checked'))
    .map(cb => JSON.parse(cb.closest('.item').dataset.item));
}
document.addEventListener('change', e => {
  const cb = e.target.closest('.item-cb');
  if (!cb) return;
  cb.closest('.item').classList.toggle('selected', cb.checked);
  dlBatchBtn.disabled = !document.querySelectorAll('.item-cb:checked').length;
  delBatchBtn.disabled = !document.querySelectorAll('.item-cb:checked').length;
});
dlBatchBtn.addEventListener('click', () => { if (!dlBatchBtn.disabled) vscodeApi.postMessage({ type: 'downloadSelected', items: getSelectedItems() }); });
delBatchBtn.addEventListener('click', () => { if (!delBatchBtn.disabled) vscodeApi.postMessage({ type: 'deleteSelected', items: getSelectedItems() }); });

// actions
document.addEventListener('click', e => {
  const action = e.target.closest('.action');
  if (!action) return;
  const itemEl = action.closest('.item');
  if (!itemEl) return;
  const act = action.dataset.action;
  const item = JSON.parse(itemEl.dataset.item);
  vscodeApi.postMessage({ type: act, item });
});

// folder double-click
document.querySelectorAll('.folder').forEach(el => {
  el.addEventListener('dblclick', () => {
    const item = JSON.parse(el.dataset.item);
    vscodeApi.postMessage({ type: 'navigate', prefix: item.fullPath.endsWith('/') ? item.fullPath : item.fullPath + '/' });
  });
});

// refresh
document.getElementById('refreshBtn')?.addEventListener('click', () => vscodeApi.postMessage({ type: 'refresh' }));
document.getElementById('newFolderBtn')?.addEventListener('click', () => vscodeApi.postMessage({ type: 'newFolder' }));
document.getElementById('uploadBtn')?.addEventListener('click', () => vscodeApi.postMessage({ type: 'upload' }));
document.getElementById('taskViewBtn')?.addEventListener('click', () => vscodeApi.postMessage({ type: 'openTaskView' }));
document.getElementById('bookmarkBtn')?.addEventListener('click', () => vscodeApi.postMessage({ type: 'showBookmarks' }));

// back button
const backBtn = document.getElementById('backBtn');
if (backBtn && !backBtn.disabled) {
  backBtn.addEventListener('click', () => vscodeApi.postMessage({ type: 'navigateUp' }));
}

// filter/search
const filterInput = document.getElementById('filterInput');
filterInput?.addEventListener('input', () => {
  const q = filterInput.value.toLowerCase();
  if (filterInput.dataset.searching) {
    document.querySelectorAll('.item').forEach(el => {
      const name = el.querySelector('.item-name')?.textContent?.toLowerCase() || '';
      el.style.display = !q || name.includes(q) ? '' : 'none';
    });
  }
});
filterInput?.addEventListener('keydown', e => {
  if (e.isComposing) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    const val = filterInput.value.trim();
    if (!val) { filterInput.value = ''; filterInput.dataset.searching = ''; vscodeApi.postMessage({ type: 'refresh' }); return; }
    filterInput.dataset.searching = '1';
    vscodeApi.postMessage({ type: 'searchFiles', pattern: val });
  } else if (e.key === 'Escape') {
    filterInput.value = '';
    filterInput.blur();
    if (filterInput.dataset.searching) {
      filterInput.dataset.searching = '';
      vscodeApi.postMessage({ type: 'refresh' });
    }
  }
});

// path input + history autocomplete
const pathInput = document.getElementById('pathInput');
const dropdown = document.getElementById('historyDropdown');
let activeIdx = -1;
let debounceTimer = null;

const historyRecords = ${JSON.stringify(historyRecords || [])};
const currentConnectionId = ${JSON.stringify(connectionId || '')};
const seen = new Map();
historyRecords.forEach(r => {
  const key = r.connectionId + '\\x00' + r.key;
  const existing = seen.get(key);
  if (!existing || r.timestamp > existing.timestamp) seen.set(key, r);
});
const dedupedRecords = Array.from(seen.values()).sort((a, b) => b.timestamp - a.timestamp);

function closeDropdown() { dropdown.classList.remove('show'); dropdown.innerHTML = ''; activeIdx = -1; }
function renderDropdown(results) {
  if (results.length === 0) { closeDropdown(); return; }
  dropdown.innerHTML = results.map((r, i) =>
    '<div class="history-item' + (i === activeIdx ? ' active' : '') + '" data-idx="' + i + '">' +
    '<div class="hi-path">' + escapeHtml(r.key) + '</div>' +
    '<div class="hi-conn">' + escapeHtml(r.connectionName) + '</div></div>'
  ).join('');
  dropdown.classList.add('show');
  const el = dropdown.querySelector('.history-item.active');
  if (el) el.scrollIntoView({ block: 'nearest' });
}
function filterHistory(query) {
  const q = query.toLowerCase();
  return dedupedRecords.filter(r => r.connectionId === currentConnectionId && r.key.toLowerCase().includes(q));
}
function selectHistoryItem(idx) {
  const results = filterHistory(pathInput.value);
  if (idx < 0 || idx >= results.length) return;
  const r = results[idx];
  closeDropdown();
  pathInput.value = r.key;
  if (r.connectionId === currentConnectionId) {
    vscodeApi.postMessage({ type: 'goToPath', path: r.key });
  } else {
    vscodeApi.postMessage({ type: 'historyJump', connectionId: r.connectionId, key: r.key });
  }
}
pathInput?.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => renderDropdown(filterHistory(pathInput.value)), 100);
});
pathInput?.addEventListener('focus', () => renderDropdown(filterHistory(pathInput.value)));
pathInput?.addEventListener('blur', () => setTimeout(closeDropdown, 150));
pathInput?.addEventListener('keydown', e => {
  if (e.isComposing) return;
  const results = filterHistory(pathInput.value);
  if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, results.length - 1); renderDropdown(results); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, -1); renderDropdown(results); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    if (activeIdx >= 0 && activeIdx < results.length) selectHistoryItem(activeIdx);
    else { closeDropdown(); vscodeApi.postMessage({ type: 'goToPath', path: pathInput.value }); }
  } else if (e.key === 'Escape') { closeDropdown(); }
});
dropdown?.addEventListener('mousedown', e => {
  const item = e.target.closest('.history-item');
  if (!item) return;
  e.preventDefault();
  selectHistoryItem(parseInt(item.dataset.idx));
});
function escapeHtml(text) { const div = document.createElement('div'); div.appendChild(document.createTextNode(text)); return div.innerHTML; }

// drag-and-drop
const overlay = document.getElementById('dragOverlay');
let dragCounter = 0;
document.addEventListener('dragenter', e => { e.preventDefault(); dragCounter++; overlay.classList.add('show'); }, true);
document.addEventListener('dragover', e => { e.preventDefault(); }, true);
document.addEventListener('dragleave', e => { e.preventDefault(); dragCounter--; if (dragCounter <= 0) { dragCounter = 0; overlay.classList.remove('show'); } }, true);
document.addEventListener('drop', async e => {
  e.preventDefault(); e.stopPropagation(); dragCounter = 0; overlay.classList.remove('show');
  const files = [];
  if (e.dataTransfer.items && e.dataTransfer.items.length) {
    for (const item of e.dataTransfer.items) {
      const f = item.getAsFile ? item.getAsFile() : null;
      if (f && f.size > 0 && !f.name.startsWith('.')) files.push(f);
    }
  } else {
    for (const f of e.dataTransfer.files) { if (f.size > 0 && !f.name.startsWith('.')) files.push(f); }
  }
  if (files.length === 0) return;
  const MAX_BASE64_SIZE = 5 * 1024 * 1024;
  const smallFiles = [];
  for (const file of files) {
    if (file.size <= MAX_BASE64_SIZE) {
      const dataUrl = await new Promise(resolve => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsDataURL(file); });
      smallFiles.push({ fileName: file.name, content: dataUrl.split(',')[1] });
    } else {
      vscodeApi.postMessage({ type: 'showError', text: 'File too large for drag-and-drop: ' + file.name + ' (max 5MB)' });
    }
  }
  if (smallFiles.length > 0) vscodeApi.postMessage({ type: 'uploadDrop', files: smallFiles });
}, true);

// context menu (right-click)
const ctxMenu = document.createElement('div');
ctxMenu.className = 'history-dropdown';
ctxMenu.style.position = 'fixed';
ctxMenu.style.zIndex = '1000';
document.body.appendChild(ctxMenu);
document.addEventListener('contextmenu', e => {
  const itemEl = e.target.closest('.item');
  if (!itemEl) { ctxMenu.classList.remove('show'); return; }
  e.preventDefault();
  const item = JSON.parse(itemEl.dataset.item);
  const isFile = item.type === 'FILE';
  ctxMenu.innerHTML = '';
  ctxMenu.style.left = e.clientX + 'px';
  ctxMenu.style.top = e.clientY + 'px';
  const add = (text, type) => {
    const d = document.createElement('div');
    d.className = 'history-item';
    d.textContent = text;
    d.addEventListener('click', () => { ctxMenu.classList.remove('show'); vscodeApi.postMessage({ type, item }); });
    ctxMenu.appendChild(d);
  };
  add(l10n.info, 'info');
  if (isFile) add(l10n.download, 'download');
  add(l10n.rename, 'rename');
  add(l10n.delete, 'delete');
  add(l10n.copyPath, 'copyPath');
  add(l10n.copyFileName, 'copyFileName');
  ctxMenu.classList.add('show');
});
document.addEventListener('click', e => {
  if (!e.target.closest('.item')) ctxMenu.classList.remove('show');
});
</script>
</body>
</html>`;
}
