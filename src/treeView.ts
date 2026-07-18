import * as vscode from 'vscode';
import { ConnectionManager, HdfsConnection } from './connectionManager';

export class HdfsTreeItem extends vscode.TreeItem {
  constructor(
    public readonly connectionId: string,
    label: string,
    public readonly connectionName: string,
    host: string,
    port: number,
    authMethod: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.id = connectionId;
    this.contextValue = 'hdfsConnection';
    this.tooltip = `${connectionName}\n${host}:${port}\nAuth: ${authMethod}`;
    this.description = `${host}:${port}`;
    this.iconPath = new vscode.ThemeIcon('server');
    this.command = {
      command: 'hdfs.openConnection',
      title: '',
      arguments: [this],
    };
  }
}

export class HdfsTreeDataProvider implements vscode.TreeDataProvider<HdfsTreeItem> {
  static connectionManager: ConnectionManager | undefined;

  private _onDidChangeTreeData = new vscode.EventEmitter<HdfsTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private connectionManager: ConnectionManager) {
    HdfsTreeDataProvider.connectionManager = connectionManager;
    connectionManager.onDidChange(() => this.refresh());
  }

  refresh(element?: HdfsTreeItem): void {
    this._onDidChangeTreeData.fire(element);
  }

  getTreeItem(element: HdfsTreeItem): vscode.TreeItem {
    return element;
  }

  getParent(): vscode.ProviderResult<HdfsTreeItem> {
    return undefined;
  }

  async getChildren(element?: HdfsTreeItem): Promise<HdfsTreeItem[]> {
    if (!element) {
      return this.getConnectionItems();
    }
    return [];
  }

  private getConnectionItems(): HdfsTreeItem[] {
    return this.connectionManager.connections.map((conn) =>
      new HdfsTreeItem(conn.id, conn.name, conn.name, conn.host, conn.port, conn.authMethod)
    );
  }
}
