import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import * as vscode from 'vscode';

let kerberosModule: any = undefined;
try {
  kerberosModule = require('kerberos');
} catch {
  // kerberos native module not available, will fall back to curl
}

export interface HdfsConfig {
  protocol: string;
  host: string;
  port: number;
  authMethod: 'SIMPLE' | 'KERBEROS' | 'CURL_KERBEROS' | 'TOKEN';
  username?: string;
  curlPath: string;
  insecure?: boolean;
  delegationToken?: string;
  principal?: string;
  keytabPath?: string;
  realm?: string;
  kdc?: string;
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

export interface ContentSummary {
  directoryCount: number;
  fileCount: number;
  length: number;
  quota: number;
  spaceConsumed: number;
  spaceQuota: number;
}

export interface DelegationToken {
  urlString: string;
  expiryTime: number;
}

function encodePath(p: string): string {
  if (!p.startsWith('/')) p = '/' + p;
  return p.split('/').map(s => encodeURIComponent(s)).join('/');
}

function appendDelegation(url: string, token?: string): string {
  if (token) {
    const sep = url.includes('?') ? '&' : '?';
    return url + sep + 'delegation=' + encodeURIComponent(token);
  }
  return url;
}

function getHttpAgent(protocol: string, insecure?: boolean): http.Agent | https.Agent | undefined {
  if (protocol === 'https:' && insecure) {
    return new https.Agent({ rejectUnauthorized: false });
  }
  return undefined;
}

export class HdfsClient {
  private baseUrl: string;

  constructor(private config: HdfsConfig) {
    this.baseUrl = `${config.protocol}://${config.host}:${config.port}/webhdfs/v1`;
  }

  private useKerberos(noAuth?: boolean): boolean {
    return !noAuth && this.config.authMethod === 'KERBEROS' && !this.config.delegationToken && !!kerberosModule;
  }

  private useCurl(): boolean {
    if (this.config.delegationToken) return false;
    return this.config.authMethod === 'CURL_KERBEROS' ||
      (this.config.authMethod === 'KERBEROS' && !kerberosModule);
  }

  async testConnection(): Promise<boolean> {
    await this.getFileStatus('/');
    return true;
  }

  async getDelegationToken(user = this.config.username || 'hdfs'): Promise<DelegationToken> {
    const url = appendDelegation(
      `${this.baseUrl}/?op=GETDELEGATIONTOKEN&user=${encodeURIComponent(user)}`,
      this.config.delegationToken
    );
    const data = await this.jsonRequest('GET', url);
    const t = data.Token;
    return { urlString: t.urlString, expiryTime: t.expiryTime };
  }

  async renewDelegationToken(token: string): Promise<number> {
    const url = appendDelegation(
      `${this.baseUrl}/?op=RENEWDELEGATIONTOKEN&token=${encodeURIComponent(token)}`,
      this.config.delegationToken
    );
    const data = await this.jsonRequest('PUT', url);
    return data.long;
  }

  async cancelDelegationToken(token: string): Promise<void> {
    const url = appendDelegation(
      `${this.baseUrl}/?op=CANCELDELEGATIONTOKEN&token=${encodeURIComponent(token)}`,
      this.config.delegationToken
    );
    await this.jsonRequest('PUT', url);
  }

  async listStatus(path: string): Promise<FileStatus[]> {
    const url = appendDelegation(
      `${this.baseUrl}${encodePath(path)}?op=LISTSTATUS`,
      this.config.delegationToken
    );
    const data = await this.jsonRequest('GET', url);
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
    const url = appendDelegation(
      `${this.baseUrl}${encodePath(path)}?op=GETFILESTATUS`,
      this.config.delegationToken
    );
    const data = await this.jsonRequest('GET', url);
    if (!data || !data.FileStatus) {
      const raw = JSON.stringify(data).substring(0, 500);
      throw new Error(`GETFILESTATUS returned unexpected response (HTTP 200): ${raw || '(empty)'}`);
    }
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

  async contentSummary(path: string): Promise<ContentSummary> {
    const url = appendDelegation(
      `${this.baseUrl}${encodePath(path)}?op=GETCONTENTSUMMARY`,
      this.config.delegationToken
    );
    const data = await this.jsonRequest('GET', url);
    return data.ContentSummary as ContentSummary;
  }

  async mkdirs(path: string): Promise<boolean> {
    const url = appendDelegation(
      `${this.baseUrl}${encodePath(path)}?op=MKDIRS`,
      this.config.delegationToken
    );
    const data = await this.jsonRequest('PUT', url);
    return data.boolean;
  }

  async delete(path: string, recursive = true): Promise<boolean> {
    const url = appendDelegation(
      `${this.baseUrl}${encodePath(path)}?op=DELETE&recursive=${recursive}`,
      this.config.delegationToken
    );
    const data = await this.jsonRequest('DELETE', url);
    return data.boolean;
  }

  async rename(path: string, destination: string): Promise<boolean> {
    const url = appendDelegation(
      `${this.baseUrl}${encodePath(path)}?op=RENAME&destination=${encodeURIComponent(destination)}`,
      this.config.delegationToken
    );
    const data = await this.jsonRequest('PUT', url);
    return data.boolean;
  }

  async readFile(path: string): Promise<Buffer> {
    const url = appendDelegation(
      `${this.baseUrl}${encodePath(path)}?op=OPEN`,
      this.config.delegationToken
    );
    if (this.useCurl()) {
      return this.curlGetData(url);
    }
    return this.followRedirect('GET', url);
  }

  async writeFile(path: string, content: Buffer): Promise<void> {
    const url = appendDelegation(
      `${this.baseUrl}${encodePath(path)}?op=CREATE`,
      this.config.delegationToken
    );
    if (this.useCurl()) {
      await this.curlPutData(url, content);
    } else {
      await this.redirectWrite('PUT', url, content);
    }
  }

  private async jsonRequest(method: string, urlStr: string): Promise<any> {
    if (this.useCurl()) {
      const { stdout } = await this.curlExec(['-X', method, urlStr]);
      return JSON.parse(stdout);
    }
    const resp = await this.rawRequest(method, urlStr);
    const body = resp.body.toString();
    let data: any;
    try {
      data = JSON.parse(body);
    } catch {
      throw new Error(`Server returned invalid JSON (HTTP ${resp.statusCode}): ${body.substring(0, 300)}`);
    }
    if (data.RemoteException) {
      throw new Error(`WebHDFS error: ${data.RemoteException.exception} — ${data.RemoteException.message}`);
    }
    return data;
  }

  private async followRedirect(method: string, urlStr: string): Promise<Buffer> {
    let resp = await this.rawRequest(method, urlStr);
    if (resp.statusCode === 307 && resp.headers.location) {
      const redirectUrl = resolveUrl(urlStr, resp.headers.location);
      resp = await this.rawRequest(method, redirectUrl, undefined, !this.useKerberos());
    }
    if (resp.statusCode >= 400) {
      throw new Error(`HTTP ${resp.statusCode}: ${resp.body.toString()}`);
    }
    return resp.body;
  }

  private async redirectWrite(method: string, urlStr: string, content: Buffer): Promise<void> {
    let resp = await this.rawRequest(method, urlStr, undefined, false, { 'Content-Type': 'application/octet-stream' });
    if (resp.statusCode === 307 && resp.headers.location) {
      const redirectUrl = resolveUrl(urlStr, resp.headers.location);
      resp = await this.rawRequest('PUT', redirectUrl, content, !this.useKerberos());
    }
    if (resp.statusCode >= 400) {
      throw new Error(`HTTP ${resp.statusCode}: ${resp.body.toString()}`);
    }
  }

  private async rawRequest(
    method: string,
    urlStr: string,
    body?: Buffer,
    noAuth?: boolean,
    extraHeaders?: Record<string, string>
  ): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
    if (this.useKerberos(noAuth)) {
      return this.kerberosRawRequest(method, urlStr, body, extraHeaders);
    }
    return this.httpRequest(method, urlStr, body, this.buildHeaders(noAuth, extraHeaders));
  }

  private buildHeaders(noAuth?: boolean, extraHeaders?: Record<string, string>): http.OutgoingHttpHeaders {
    const headers: http.OutgoingHttpHeaders = { ...extraHeaders };
    if (!noAuth) {
      if (this.config.delegationToken) {
        // delegation token is passed as query param, no extra header needed
      } else if (this.config.authMethod === 'TOKEN' && this.config.delegationToken) {
        headers['Authorization'] = 'Bearer ' + this.config.delegationToken;
      } else if (this.config.username) {
        headers['X-Hadoop-RemoteUser'] = this.config.username;
      }
    }
    return headers;
  }

  private httpRequest(
    method: string,
    urlStr: string,
    body?: Buffer,
    headers?: http.OutgoingHttpHeaders,
  ): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const u = new URL(urlStr);
      const mod = u.protocol === 'https:' ? https : http;
      const agent = getHttpAgent(u.protocol, this.config.insecure);
      const opts: http.RequestOptions = {
        method,
        hostname: u.hostname,
        port: parseInt(u.port) || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers,
        agent,
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

  private async ensureKinit(): Promise<void> {
    if (this.config.authMethod !== 'KERBEROS' && this.config.authMethod !== 'CURL_KERBEROS') return;
    if (this.config.delegationToken) return;
    const principal = this.config.principal || vscode.workspace.getConfiguration('hdfs').get<string>('auth.kerberos.principal');
    const keytab = this.config.keytabPath || vscode.workspace.getConfiguration('hdfs').get<string>('auth.kerberos.keytab');
    if (!principal || !keytab) return;

    const krb5Path = await this.ensureKrb5Config();
    const env = { ...process.env };
    if (krb5Path) env.KRB5_CONFIG = krb5Path;

    await new Promise<void>((resolve, reject) => {
      const child = execFile('kinit', ['-kt', keytab, principal], { env }, (err, _stdout, stderr) => {
        if (err) reject(new Error(`kinit failed: ${stderr || err.message}`));
        else resolve();
      });
    });
  }

  private async ensureKrb5Config(): Promise<string | undefined> {
    if (fs.existsSync('/etc/krb5.conf') || fs.existsSync('/etc/krb5/krb5.conf')) {
      return undefined;
    }
    const realm = this.config.realm;
    const kdc = this.config.kdc;
    if (!realm || !kdc) return undefined;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hdfs-krb5-'));
    const configPath = path.join(tmpDir, 'krb5.conf');
    const content = `[libdefaults]
  renew_lifetime = 7d
  forwardable = true
  default_realm = ${realm}
  dns_lookup_realm = false
  dns_lookup_kdc = false
  ticket_lifetime = 24h

[realms]
  ${realm} = {
    kdc = ${kdc}
    admin_server = ${kdc}
  }

[domain_realm]
  .${realm.toLowerCase()} = ${realm}
  ${realm.toLowerCase()} = ${realm}
`;
    fs.writeFileSync(configPath, content, 'utf-8');
    return configPath;
  }

  private async kerberosRawRequest(
    method: string,
    urlStr: string,
    body?: Buffer,
    extraHeaders?: Record<string, string>,
  ): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
    await this.ensureKinit();

    const u = new URL(urlStr);
    const servicePrincipal = `HTTP@${u.hostname}`;

    let client: any;
    let initialToken: string;
    try {
      client = await kerberosModule.initializeClient(servicePrincipal, {
        mechOID: kerberosModule.GSS_MECH_OID_SPNEGO,
        principal: this.config.principal || undefined,
        gssFlag: kerberosModule.GSS_C_MUTUAL_FLAG | kerberosModule.GSS_C_REPLAY_FLAG | kerberosModule.GSS_C_SEQUENCE_FLAG,
      });
      initialToken = await client.step('');
    } catch (err: any) {
      if (kerberosModule) {
        throw new Error(`Kerberos auth failed for ${servicePrincipal}: ${err.message}`);
      }
      throw new Error(`Kerberos native module not available. Install 'kerberos' npm package or use curl fallback.`);
    }

    // Try preemptive auth first
    const authHeaders: http.OutgoingHttpHeaders = {
      'Authorization': 'Negotiate ' + initialToken,
      ...extraHeaders,
    };
    let resp = await this.httpRequest(method, urlStr, body, authHeaders);

    // If server responds with challenge → complete handshake
    if (resp.statusCode === 401) {
      const challenge = parseNegotiateChallenge(resp.headers['www-authenticate']);
      if (challenge) {
        try {
          const responseToken = await client.step(challenge);
          authHeaders['Authorization'] = 'Negotiate ' + responseToken;
          resp = await this.httpRequest(method, urlStr, body, authHeaders);
        } catch (err2: any) {
          throw new Error(`Kerberos handshake failed: ${err2.message}`);
        }
      } else {
        throw new Error(`HTTP 401 — Server requires Negotiate auth but no challenge provided`);
      }
    }

    // If still 401 after full handshake → fail
    if (resp.statusCode === 401) {
      throw new Error(`HTTP 401 Unauthorized — Kerberos authentication failed for ${servicePrincipal}`);
    }

    return resp;
  }

  private curlArgs(): string[] {
    const args = ['--negotiate', '-u', ':', '--location', '--silent', '--show-error'];
    if (this.config.insecure) args.push('--insecure');
    return args;
  }

  private async resolveCurlPath(): Promise<string> {
    const configured = this.config.curlPath;
    if (configured && configured !== 'curl' && !configured.includes(' ')) {
      return configured;
    }
    const knownPaths = ['/usr/bin/curl', '/opt/homebrew/bin/curl', '/usr/local/bin/curl', '/bin/curl'];
    for (const p of knownPaths) {
      try {
        await fs.promises.access(p, fs.constants.X_OK);
        return p;
      } catch { /* not found */ }
    }
    try {
      const curlPath = await new Promise<string>((resolve, reject) => {
        require('child_process').exec('which curl', (err: any, stdout: string) => {
          if (err) reject(err);
          else resolve(stdout.trim());
        });
      });
      if (curlPath) return curlPath;
    } catch { /* not found via which */ }
    return 'curl';
  }

  private async curlExec(args: string[]): Promise<{ stdout: string; stderr: string }> {
    await this.ensureKinit();
    const curl = await this.resolveCurlPath();
    return new Promise((resolve, reject) => {
      execFile(curl, [...this.curlArgs(), ...args], { shell: true, maxBuffer: 100 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error(`curl failed: ${err.message}`));
        else resolve({ stdout, stderr });
      });
    });
  }

  private async curlGetData(urlStr: string): Promise<Buffer> {
    const { stdout } = await this.curlExec(['-X', 'GET', urlStr]);
    return Buffer.from(stdout);
  }

  private async curlPutData(urlStr: string, content: Buffer): Promise<void> {
    const curl = await this.resolveCurlPath();
    const tmpFile = path.join(os.tmpdir(), `hdfs-upload-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(tmpFile, content);
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(curl, [
          ...this.curlArgs(), '-X', 'PUT', '-T', tmpFile, urlStr,
        ], { shell: true });
        let stderr = '';
        if (child.stderr) child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        child.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`curl exited with code ${code}\n${stderr}`));
        });
        child.on('error', reject);
      });
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  }

  async kinit(principal?: string, keytab?: string): Promise<void> {
    const p = principal || this.config.principal || vscode.workspace.getConfiguration('hdfs').get<string>('auth.kerberos.principal');
    const k = keytab || this.config.keytabPath || vscode.workspace.getConfiguration('hdfs').get<string>('auth.kerberos.keytab');
    if (!p) throw new Error('Kerberos principal not provided.');
    const krb5Path = await this.ensureKrb5Config();
    const env = { ...process.env };
    if (krb5Path) env.KRB5_CONFIG = krb5Path;
    const args: string[] = [];
    if (k) args.push('-kt', k);
    args.push(p);
    await new Promise<void>((resolve, reject) => {
      execFile('kinit', args, { env }, (err, _stdout, stderr) => {
        if (err) reject(new Error(`kinit failed: ${stderr || err.message}`));
        else resolve();
      });
    });
  }
}

function parseNegotiateChallenge(header: string | string[] | undefined): string | null {
  if (!header) return null;
  const values = Array.isArray(header) ? header : [header];
  for (const v of values) {
    const match = v.match(/Negotiate\s+(.+)/i);
    if (match) return match[1];
  }
  return null;
}

function resolveUrl(base: string, location: string): string {
  if (location.startsWith('http://') || location.startsWith('https://')) return location;
  const u = new URL(base);
  return `${u.protocol}//${u.host}${location.startsWith('/') ? '' : u.pathname.replace(/\/[^/]*$/, '/')}${location}`;
}
