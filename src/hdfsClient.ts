import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';

export interface HdfsConfig {
  serviceUrl: string;
  sessionId?: string;
  coreSitePath?: string;
  hdfsSitePath?: string;
  krb5ConfPath?: string;
  keytabPath?: string;
  principal?: string;
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

export class HdfsClient {
  private baseUrl: string;
  private sessionId: string | null;

  constructor(private config: HdfsConfig) {
    this.baseUrl = config.serviceUrl.replace(/\/+$/, '');
    this.sessionId = config.sessionId || null;
  }

  async createSession(): Promise<string> {
    const files: { fieldName: string; filePath: string; required: boolean }[] = [
      { fieldName: 'coreSite', filePath: this.config.coreSitePath || '', required: true },
      { fieldName: 'hdfsSite', filePath: this.config.hdfsSitePath || '', required: true },
      { fieldName: 'krb5Conf', filePath: this.config.krb5ConfPath || '', required: false },
      { fieldName: 'keytab', filePath: this.config.keytabPath || '', required: false },
    ];

    const boundary = '----HdfsFormBoundary' + Math.random().toString(36).substring(2, 15);
    const parts: Buffer[] = [];

    for (const f of files) {
      if (!f.filePath) continue;
      if (!fs.existsSync(f.filePath)) {
        if (f.required) throw new Error(`Required file not found: ${f.filePath}`);
        continue;
      }
      const content = fs.readFileSync(f.filePath);
      const filename = path.basename(f.filePath);
      parts.push(Buffer.from(`--${boundary}\r\n`));
      parts.push(Buffer.from(`Content-Disposition: form-data; name="${f.fieldName}"; filename="${filename}"\r\n`));
      parts.push(Buffer.from('Content-Type: application/octet-stream\r\n\r\n'));
      parts.push(content);
      parts.push(Buffer.from('\r\n'));
    }

    if (this.config.principal) {
      parts.push(Buffer.from(`--${boundary}\r\n`));
      parts.push(Buffer.from(`Content-Disposition: form-data; name="principal"\r\n\r\n`));
      parts.push(Buffer.from(this.config.principal));
      parts.push(Buffer.from('\r\n'));
    }

    parts.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(parts);
    const url = new URL('/api/session', this.baseUrl);
    const resp = await this.rawRequest('POST', url.toString(), body, {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    });

    const data = JSON.parse(resp.body.toString());
    if (!data.sessionId) {
      throw new Error(`Server did not return sessionId: ${resp.body.toString().substring(0, 200)}`);
    }
    this.sessionId = data.sessionId;
    return data.sessionId;
  }

  async ensureSession(): Promise<string> {
    if (this.sessionId) return this.sessionId;
    return this.createSession();
  }

  async testConnection(): Promise<boolean> {
    try {
      const sid = await this.ensureSession();
      const url = new URL(`/api/session/${encodeURIComponent(sid)}/test`, this.baseUrl);
      const resp = await this.rawRequest('POST', url.toString());
      const data = JSON.parse(resp.body.toString());
      return data.connected === true;
    } catch {
      return false;
    }
  }

  async listStatus(hdfsPath: string): Promise<FileStatus[]> {
    const sid = await this.ensureSession();
    const url = new URL('/api/hdfs/list', this.baseUrl);
    url.searchParams.set('sessionId', sid);
    url.searchParams.set('path', hdfsPath);
    const resp = await this.rawRequest('GET', url.toString());
    return JSON.parse(resp.body.toString());
  }

  async getFileStatus(hdfsPath: string): Promise<FileStatus> {
    const sid = await this.ensureSession();
    const url = new URL('/api/hdfs/status', this.baseUrl);
    url.searchParams.set('sessionId', sid);
    url.searchParams.set('path', hdfsPath);
    const resp = await this.rawRequest('GET', url.toString());
    return JSON.parse(resp.body.toString());
  }

  async contentSummary(hdfsPath: string): Promise<ContentSummary> {
    const sid = await this.ensureSession();
    const url = new URL('/api/hdfs/summary', this.baseUrl);
    url.searchParams.set('sessionId', sid);
    url.searchParams.set('path', hdfsPath);
    const resp = await this.rawRequest('GET', url.toString());
    return JSON.parse(resp.body.toString());
  }

  async mkdirs(hdfsPath: string): Promise<boolean> {
    const sid = await this.ensureSession();
    const url = new URL('/api/hdfs/mkdir', this.baseUrl);
    url.searchParams.set('sessionId', sid);
    url.searchParams.set('path', hdfsPath);
    const resp = await this.rawRequest('POST', url.toString());
    const data = JSON.parse(resp.body.toString());
    return data.success === true;
  }

  async delete(hdfsPath: string, recursive = true): Promise<boolean> {
    const sid = await this.ensureSession();
    const url = new URL('/api/hdfs/delete', this.baseUrl);
    url.searchParams.set('sessionId', sid);
    url.searchParams.set('path', hdfsPath);
    url.searchParams.set('recursive', String(recursive));
    const resp = await this.rawRequest('DELETE', url.toString());
    const data = JSON.parse(resp.body.toString());
    return data.success === true;
  }

  async rename(hdfsPath: string, destination: string): Promise<boolean> {
    const sid = await this.ensureSession();
    const url = new URL('/api/hdfs/rename', this.baseUrl);
    url.searchParams.set('sessionId', sid);
    url.searchParams.set('path', hdfsPath);
    url.searchParams.set('destination', destination);
    const resp = await this.rawRequest('POST', url.toString());
    const data = JSON.parse(resp.body.toString());
    return data.success === true;
  }

  async readFile(hdfsPath: string): Promise<Buffer> {
    const sid = await this.ensureSession();
    const url = new URL('/api/hdfs/read', this.baseUrl);
    url.searchParams.set('sessionId', sid);
    url.searchParams.set('path', hdfsPath);
    const resp = await this.rawRequest('GET', url.toString());
    return resp.body;
  }

  async writeFile(hdfsPath: string, content: Buffer): Promise<void> {
    const sid = await this.ensureSession();
    const url = new URL('/api/hdfs/write', this.baseUrl);
    url.searchParams.set('sessionId', sid);
    url.searchParams.set('path', hdfsPath);

    const boundary = '----HdfsFormBoundary' + Math.random().toString(36).substring(2, 15);
    const parts: Buffer[] = [
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="file"; filename="file"\r\n`),
      Buffer.from('Content-Type: application/octet-stream\r\n\r\n'),
      content,
      Buffer.from('\r\n'),
      Buffer.from(`--${boundary}--\r\n`),
    ];
    const body = Buffer.concat(parts);

    const resp = await this.rawRequest('POST', url.toString(), body, {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    });
    if (resp.status >= 400) {
      const msg = resp.body.length > 0 ? resp.body.toString().substring(0, 300) : `HTTP ${resp.status}`;
      throw new Error(`Write failed: ${msg}`);
    }
  }

  async deleteSession(): Promise<void> {
    if (!this.sessionId) return;
    try {
      const url = new URL(`/api/session/${encodeURIComponent(this.sessionId)}`, this.baseUrl);
      await this.rawRequest('DELETE', url.toString());
    } catch {
      // ignore cleanup errors
    }
    this.sessionId = null;
  }

  private async rawRequest(
    method: string,
    urlStr: string,
    body?: Buffer,
    headers?: Record<string, string>,
  ): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const u = new URL(urlStr);
      const mod = u.protocol === 'https:' ? https : http;
      const opts: http.RequestOptions = {
        method,
        hostname: u.hostname,
        port: u.port ? parseInt(u.port) : (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: {
          ...headers,
        },
      };
      if (body) {
        opts.headers = { ...opts.headers, 'Content-Length': String(body.length) };
      }

      const req = mod.request(opts, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode && res.statusCode >= 400) {
            let msg: string;
            try {
              const j = JSON.parse(buf.toString());
              msg = j.error || j.message || buf.toString().substring(0, 300);
            } catch {
              msg = buf.toString().substring(0, 300);
            }
            reject(new Error(`Service error (${res.statusCode}): ${msg}`));
          } else {
            resolve({ status: res.statusCode || 200, headers: res.headers, body: buf });
          }
        });
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }
}
