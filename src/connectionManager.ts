import * as vscode from 'vscode';

export interface HdfsConnection {
  id: string;
  name: string;
  protocol: string;
  host: string;
  port: number;
  authMethod: 'SIMPLE' | 'KERBEROS';
  username: string;
  curlPath: string;
  insecure: boolean;
}

const STORAGE_KEY = 'hdfsConnections';

export class ConnectionManager {
  private _connections: HdfsConnection[] = [];
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private storage: vscode.Memento;

  constructor(context: vscode.ExtensionContext) {
    this.storage = context.globalState;
    this.load();
  }

  private load(): void {
    this._connections = this.storage.get<HdfsConnection[]>(STORAGE_KEY, []);
  }

  private async save(): Promise<void> {
    await this.storage.update(STORAGE_KEY, this._connections);
    this._onDidChange.fire();
  }

  get connections(): HdfsConnection[] {
    return [...this._connections];
  }

  getConnection(id: string): HdfsConnection | undefined {
    return this._connections.find(c => c.id === id);
  }

  async addConnection(params: Omit<HdfsConnection, 'id'>): Promise<HdfsConnection> {
    const id = `hdfs-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    const conn: HdfsConnection = { ...params, id };
    this._connections.push(conn);
    await this.save();
    return conn;
  }

  async updateConnection(id: string, params: Partial<HdfsConnection>): Promise<HdfsConnection | undefined> {
    const idx = this._connections.findIndex(c => c.id === id);
    if (idx === -1) return undefined;
    this._connections[idx] = { ...this._connections[idx], ...params, id };
    await this.save();
    return this._connections[idx];
  }

  async removeConnection(id: string): Promise<void> {
    this._connections = this._connections.filter(c => c.id !== id);
    await this.save();
  }
}
