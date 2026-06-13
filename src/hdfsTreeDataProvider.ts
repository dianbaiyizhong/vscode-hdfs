import * as vscode from 'vscode';
import { HdfsClient, HdfsConfig, FileStatus } from './hdfsClient';

export interface StoredConnection {
  id: string;
  name: string;
  protocol: string;
  host: string;
  port: number;
  authMethod: 'SIMPLE' | 'KERBEROS';
  username: string;
  curlPath: string;
}

export class HdfsNode extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly kind: 'connection' | 'directory' | 'file',
    public readonly connection?: StoredConnection,
    public readonly fullPath?: string,
    public readonly connectionId?: string,
    public readonly fileStatus?: FileStatus
  ) {
    super(label, collapsibleState);

    if (kind === 'connection') {
      this.contextValue = 'hdfsConnection';
      this.description = `${connection!.host}:${connection!.port}`;
      this.tooltip = `${connection!.name}\n${connection!.host}:${connection!.port}\nAuth: ${connection!.authMethod}`;
      this.iconPath = new vscode.ThemeIcon('server');
    } else if (kind === 'directory') {
      this.contextValue = 'hdfsDirectory';
      this.tooltip = fullPath;
      this.iconPath = vscode.ThemeIcon.Folder;
    } else {
      this.contextValue = 'hdfsFile';
      this.description = fileStatus ? formatSize(fileStatus.length) : '';
      this.tooltip = fullPath || '';
      this.iconPath = vscode.ThemeIcon.File;
      this.command = {
        command: 'hdfs.openFile',
        title: 'Open File',
        arguments: [this],
      };
    }
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export class HdfsTreeDataProvider implements vscode.TreeDataProvider<HdfsNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<HdfsNode | undefined>();
  readonly onDidChangeTreeData: vscode.Event<HdfsNode | undefined> = this._onDidChangeTreeData.event;

  private _connections: StoredConnection[] = [];
  private clients = new Map<string, HdfsClient>();

  constructor() {}

  get connections(): StoredConnection[] {
    return this._connections;
  }

  set connections(list: StoredConnection[]) {
    this._connections = list;
    this.clients.clear();
  }

  getClient(conn: StoredConnection): HdfsClient {
    let client = this.clients.get(conn.id);
    if (!client) {
      const config: HdfsConfig = {
        protocol: conn.protocol,
        host: conn.host,
        port: conn.port,
        authMethod: conn.authMethod,
        username: conn.username,
        curlPath: vscode.workspace.getConfiguration('hdfs').get<string>('curl.path', 'curl'),
      };
      client = new HdfsClient(config);
      this.clients.set(conn.id, client);
    }
    return client;
  }

  refresh(item?: HdfsNode): void {
    this._onDidChangeTreeData.fire(item);
  }

  getTreeItem(element: HdfsNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: HdfsNode): Promise<HdfsNode[]> {
    if (!element) {
      return this._connections.map(c =>
        new HdfsNode(c.name, vscode.TreeItemCollapsibleState.Collapsed, 'connection', c)
      );
    }

    if (element.kind === 'connection') {
      const conn = element.connection!;
      const client = this.getClient(conn);
      return this.listDir(client, '/', conn.id);
    }

    if (element.kind === 'directory') {
      const client = this.clients.get(element.connectionId!);
      if (!client) return [];
      return this.listDir(client, element.fullPath!, element.connectionId!);
    }

    return [];
  }

  private async listDir(client: HdfsClient, path: string, connId: string): Promise<HdfsNode[]> {
    try {
      const files = await client.listStatus(path);
      return files
        .filter(f => !f.pathSuffix.startsWith('_') && !f.pathSuffix.startsWith('.'))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === 'DIRECTORY' ? -1 : 1;
          return a.pathSuffix.localeCompare(b.pathSuffix);
        })
        .map(f => {
          const full = path === '/' ? '/' + f.pathSuffix : path + '/' + f.pathSuffix;
          const collapsible = f.type === 'DIRECTORY'
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None;
          return new HdfsNode(
            f.pathSuffix,
            collapsible,
            f.type === 'DIRECTORY' ? 'directory' : 'file',
            undefined,
            full,
            connId,
            f
          );
        });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to list ${path}: ${msg}`);
      return [];
    }
  }
}
