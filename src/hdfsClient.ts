import * as http from 'http';
import * as https from 'https';
import { execFile, spawn } from 'child_process';
import * as vscode from 'vscode';

export interface HdfsConfig {
  protocol: string;
  host: string;
  port: number;
  authMethod: 'SIMPLE' | 'KERBEROS';
  username?: string;
  curlPath: string;
}

export interface FileStatus {
  pathSuffix: string;
  type: 'FILE' | 'DIRECTORY';
  length: number;
  modificationTime: number;
  permission: string;
  owner: string;
  group: string;
  replication: number;
  blockSize: number;
}

function encodePath(p: string): string {
  if (!p.startsWith('/')) p = '/' + p;
  return p.split('/').map(s => encodeURIComponent(s)).join('/');
}

export class HdfsClient {
  private baseUrl: string;

  constructor(private config: HdfsConfig) {
    this.baseUrl = `${config.protocol}://${config.host}:${config.port}/webhdfs/v1`;
  }

  async listStatus(path: string): Promise<FileStatus[]> {
    const data = await this.jsonRequest('GET', `${this.baseUrl}${encodePath(path)}?op=LISTSTATUS`);
    return data.FileStatuses.FileStatus.map((fs: any) => ({
      pathSuffix: fs.pathSuffix,
      type: fs.type as 'FILE' | 'DIRECTORY',
      length: fs.length,
      modificationTime: fs.modificationTime,
      permission: fs.permission,
      owner: fs.owner,
      group: fs.group,
      replication: fs.replication,
      blockSize: fs.blockSize,
    }));
  }

  async getFileStatus(path: string): Promise<FileStatus> {
    const data = await this.jsonRequest('GET', `${this.baseUrl}${encodePath(path)}?op=GETFILESTATUS`);
    const fs = data.FileStatus;
    return {
      pathSuffix: path.split('/').pop() || '',
      type: fs.type as 'FILE' | 'DIRECTORY',
      length: fs.length,
      modificationTime: fs.modificationTime,
      permission: fs.permission,
      owner: fs.owner,
      group: fs.group,
      replication: fs.replication,
      blockSize: fs.blockSize,
    };
  }

  async mkdirs(path: string): Promise<boolean> {
    const data = await this.jsonRequest('PUT', `${this.baseUrl}${encodePath(path)}?op=MKDIRS`);
    return data.boolean;
  }

  async delete(path: string, recursive = true): Promise<boolean> {
    const data = await this.jsonRequest('DELETE', `${this.baseUrl}${encodePath(path)}?op=DELETE&recursive=${recursive}`);
    return data.boolean;
  }

  async rename(path: string, destination: string): Promise<boolean> {
    const data = await this.jsonRequest('PUT', `${this.baseUrl}${encodePath(path)}?op=RENAME&destination=${encodeURIComponent(destination)}`);
    return data.boolean;
  }

  async readFile(path: string): Promise<Buffer> {
    if (this.config.authMethod === 'KERBEROS') {
      return this.curlGetData(`${this.baseUrl}${encodePath(path)}?op=OPEN`);
    }
    return this.followRedirect('GET', `${this.baseUrl}${encodePath(path)}?op=OPEN`);
  }

  async writeFile(path: string, content: Buffer): Promise<void> {
    if (this.config.authMethod === 'KERBEROS') {
      await this.curlPutData(`${this.baseUrl}${encodePath(path)}?op=CREATE`, content);
    } else {
      await this.redirectWrite('PUT', `${this.baseUrl}${encodePath(path)}?op=CREATE`, content);
    }
  }

  private async jsonRequest(method: string, urlStr: string): Promise<any> {
    if (this.config.authMethod === 'KERBEROS') {
      const { stdout } = await this.curlExec(['-X', method, urlStr]);
      return JSON.parse(stdout);
    }
    const resp = await this.rawRequest(method, urlStr);
    return JSON.parse(resp.body.toString());
  }

  private async followRedirect(method: string, urlStr: string): Promise<Buffer> {
    let resp = await this.rawRequest(method, urlStr);
    if (resp.statusCode === 307 && resp.headers.location) {
      resp = await this.rawRequest(method, resolveUrl(urlStr, resp.headers.location), undefined, true);
    }
    if (resp.statusCode >= 400) {
      throw new Error(`HTTP ${resp.statusCode}: ${resp.body.toString()}`);
    }
    return resp.body;
  }

  private async redirectWrite(method: string, urlStr: string, content: Buffer): Promise<void> {
    let resp = await this.rawRequest(method, urlStr, undefined, false, { 'Content-Type': 'application/octet-stream' });
    if (resp.statusCode === 307 && resp.headers.location) {
      resp = await this.rawRequest('PUT', resolveUrl(urlStr, resp.headers.location), content, true);
    }
    if (resp.statusCode >= 400) {
      throw new Error(`HTTP ${resp.statusCode}: ${resp.body.toString()}`);
    }
  }

  private rawRequest(
    method: string,
    urlStr: string,
    body?: Buffer,
    noAuth?: boolean,
    extraHeaders?: Record<string, string>
  ): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const u = new URL(urlStr);
      const mod = u.protocol === 'https:' ? https : http;
      const headers: http.OutgoingHttpHeaders = { ...extraHeaders };
      if (!noAuth && this.config.username) {
        headers['X-Hadoop-RemoteUser'] = this.config.username;
      }
      const opts: http.RequestOptions = {
        method,
        hostname: u.hostname,
        port: parseInt(u.port) || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers,
      };
      const req = mod.request(opts, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ statusCode: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  private curlExec(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const curl = this.config.curlPath || 'curl';
    return new Promise((resolve, reject) => {
      execFile(curl, [
        '--negotiate', '-u', ':',
        '--location', '--silent', '--show-error',
        ...args,
      ], { maxBuffer: 100 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error(`curl failed: ${err.message}\n${stderr}`));
        else resolve({ stdout, stderr });
      });
    });
  }

  private async curlGetData(urlStr: string): Promise<Buffer> {
    const { stdout } = await this.curlExec(['-X', 'GET', urlStr]);
    return Buffer.from(stdout);
  }

  private curlPutData(urlStr: string, content: Buffer): Promise<void> {
    const curl = this.config.curlPath || 'curl';
    return new Promise((resolve, reject) => {
      const child = spawn(curl, [
        '--negotiate', '-u', ':',
        '--location', '--silent', '--show-error',
        '-X', 'PUT',
        '-T', '-',
        urlStr,
      ]);
      child.stdin.write(content);
      child.stdin.end();
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`curl exited with code ${code}\n${stderr}`));
      });
      child.on('error', reject);
    });
  }

  async kinit(): Promise<void> {
    const principal = vscode.workspace.getConfiguration('hdfs').get<string>('auth.kerberos.principal');
    const keytab = vscode.workspace.getConfiguration('hdfs').get<string>('auth.kerberos.keytab');
    if (!principal) throw new Error('Kerberos principal not configured (hdfs.auth.kerberos.principal)');
    const args = ['-kt', keytab || '', principal];
    await new Promise<void>((resolve, reject) => {
      execFile('kinit', args, (err, _stdout, stderr) => {
        if (err) reject(new Error(`kinit failed: ${stderr || err.message}`));
        else resolve();
      });
    });
  }
}

function resolveUrl(base: string, location: string): string {
  if (location.startsWith('http://') || location.startsWith('https://')) return location;
  const u = new URL(base);
  return `${u.protocol}//${u.host}${location.startsWith('/') ? '' : u.pathname.replace(/\/[^/]*$/, '/')}${location}`;
}
