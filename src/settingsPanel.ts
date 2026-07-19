import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ConnectionManager, HdfsConnection } from './connectionManager';
import { HdfsClient } from './hdfsClient';
import { t, isZh } from './i18n';

export class SettingsPanel {
  public static currentPanel: SettingsPanel | undefined;
  public static extensionUri: vscode.Uri | undefined;

  private static _iconsLoaded = false;
  private static backSvg = '';

  private static loadIcons(): void {
    if (SettingsPanel._iconsLoaded) return;
    SettingsPanel._iconsLoaded = true;
    const extPath = vscode.extensions.getExtension('nntk.vscode-hdfs')?.extensionPath;
    if (!extPath) return;
    const actDir = path.join(extPath, 'resources', 'action-icons');
    SettingsPanel.backSvg = readSvg(path.join(actDir, 'back.svg'));
  }

  public static createOrShow(connectionManager: ConnectionManager, connectionId?: string): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (SettingsPanel.currentPanel) {
      SettingsPanel.currentPanel.panel.reveal(column);
      SettingsPanel.currentPanel.update(connectionManager);
      if (connectionId) {
        SettingsPanel.currentPanel.editConnection(connectionId);
      }
      return;
    }
    SettingsPanel.currentPanel = new SettingsPanel(column, connectionManager, connectionId);
  }

  private panel: vscode.WebviewPanel;
  private connectionManager: ConnectionManager;
  private editingId: string | undefined;
  private formData: Partial<HdfsConnection> = {};

  private constructor(column: vscode.ViewColumn, connectionManager: ConnectionManager, connectionId?: string) {
    this.connectionManager = connectionManager;
    SettingsPanel.loadIcons();

    this.panel = vscode.window.createWebviewPanel(
      'hdfsSettings',
      t('wv_settings_title'),
      column,
      { enableScripts: true }
    );
    this.panel.iconPath = new vscode.ThemeIcon('gear');

    if (connectionId) {
      this.editConnection(connectionId);
    } else {
      this.render();
    }

    this.panel.onDidDispose(() => {
      SettingsPanel.currentPanel = undefined;
    });

    this.panel.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'ready':
          this.render();
          break;
        case 'add':
          this.editingId = undefined;
          this.formData = { protocol: 'http', port: 50070, authMethod: 'SIMPLE', insecure: false };
          this.renderForm();
          break;
        case 'edit':
          this.editConnection(message.connectionId);
          break;
        case 'delete':
          const id = message.connectionId as string;
          const c = this.connectionManager.getConnection(id);
          if (c) {
            const confirmed = await vscode.window.showWarningMessage(
              t('msg_removeConfirm', c.name),
              { modal: true },
              t('msg_removeBtn')
            );
            if (confirmed) {
              await this.connectionManager.removeConnection(id);
              this.render();
            }
          }
          break;
        case 'save':
          await this.handleSave(message.data);
          break;
        case 'cancel':
          this.editingId = undefined;
          this.formData = {};
          this.render();
          break;
        case 'test':
          await this.handleTest(message.data);
          break;
      }
    });
  }

  private async update(connectionManager: ConnectionManager): Promise<void> {
    this.connectionManager = connectionManager;
    this.render();
  }

  private render(): void {
    this.panel.webview.html = getListHtml(this.connectionManager.connections);
  }

  private renderForm(): void {
    this.panel.webview.html = getFormHtml(this.formData, !!this.editingId, SettingsPanel.backSvg);
  }

  private editConnection(connectionId: string): void {
    this.editingId = connectionId;
    const conn = this.connectionManager.getConnection(connectionId);
    if (conn) {
      this.formData = { ...conn };
      this.renderForm();
    }
  }

  private async handleSave(data: any): Promise<void> {
    if (!data) return;
    if (!data.name || !data.host || !data.port) {
      vscode.window.showErrorMessage(t('val_required'));
      return;
    }
    const conn: HdfsConnection = {
      id: this.editingId || '',
      name: data.name,
      protocol: data.protocol || 'http',
      host: data.host,
      port: parseInt(data.port) || 50070,
      authMethod: data.authMethod || 'SIMPLE',
      username: data.username || '',
      curlPath: data.curlPath || 'curl',
      principal: data.principal || '',
      keytabPath: data.keytabPath || '',
      realm: data.realm || '',
      kdc: data.kdc || '',
      insecure: data.insecure === true || data.insecure === 'true',
      delegationToken: data.delegationToken || '',
    };
    if (this.editingId) {
      conn.id = this.editingId;
      await this.connectionManager.updateConnection(this.editingId, conn);
    } else {
      await this.connectionManager.addConnection(conn);
    }
    this.editingId = undefined;
    this.formData = {};
    this.render();
  }

  private async handleTest(data: any): Promise<void> {
    if (!data) return;
    const host = data.host || '';
    const port = parseInt(data.port) || 50070;
    const protocol = data.protocol || 'http';
    const authMethod = data.authMethod || 'SIMPLE';
    const username = data.username || '';
    const principal = data.principal || '';
    const keytabPath = data.keytabPath || '';
    const realm = data.realm || '';
    const kdc = data.kdc || '';
    const delegationToken = data.delegationToken || '';
    if (!host || !port) {
      vscode.window.showErrorMessage(t('val_endpointRequired'));
      return;
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('msg_testingConnection') },
      async () => {
        try {
          const client = new HdfsClient({
            protocol, host, port, authMethod, username,
            curlPath: data.curlPath || 'curl',
            principal, keytabPath, realm, kdc,
            insecure: data.insecure === true || data.insecure === 'true',
            delegationToken: delegationToken || undefined,
          });
          const ok = await client.testConnection();
          if (ok) {
            vscode.window.showInformationMessage(t('msg_connected', host));
          } else {
            vscode.window.showErrorMessage(t('msg_connectionFailed', 'Connection test returned false'));
          }
        } catch (err: any) {
          vscode.window.showErrorMessage(t('msg_connectionFailed', err.message));
        }
      }
    );
  }
}

function readSvg(p: string): string {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch { return ''; }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getListHtml(connections: HdfsConnection[]): string {
  const rows = connections.length === 0
    ? `<div class="empty">${t('wv_settings_empty')}</div>`
    : connections.map(c => {
        const authTag = c.authMethod === 'KERBEROS'
          ? `<span class="proxy-tag" style="background:#7c3aed;">KERBEROS</span>`
          : c.authMethod === 'CURL_KERBEROS'
          ? `<span class="proxy-tag" style="background:#7c3aed;">CURL</span>`
          : c.authMethod === 'TOKEN'
          ? `<span class="proxy-tag" style="background:#0891b2;">TOKEN</span>`
          : `<span class="proxy-tag" style="background:#2563eb;">SIMPLE</span>`;
        const sslTag = c.protocol === 'https'
          ? `<span class="proxy-tag" style="background:#059669;">HTTPS</span>`
          : '';
        return `<div class="conn-row" data-id="${c.id}">
          <div class="conn-info">
            <span class="conn-icon">☁️</span>
            <div class="conn-details">
              <div class="conn-name">${escapeHtml(c.name)} ${authTag}${sslTag}</div>
              <div class="conn-meta">${escapeHtml(c.host)}:${c.port}</div>
            </div>
          </div>
          <div class="conn-actions">
            <button class="action-btn edit-btn" data-action="edit" title="${t('wv_settings_edit')}">✏️</button>
            <button class="action-btn delete-btn" data-action="delete" title="${t('wv_settings_delete')}">🗑️</button>
          </div>
        </div>`;
      }).join('\n');

  return `<!DOCTYPE html>
<html lang="${isZh() ? 'zh-CN' : 'en'}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
body { margin:0; padding:16px; font-family:var(--vscode-font-family); font-size:var(--vscode-font-size); color:var(--vscode-foreground); background:var(--vscode-editor-background); }
.header { display:flex; align-items:center; justify-content:space-between; margin-bottom:16px; }
.header-title { font-size:18px; font-weight:600; }
.empty { text-align:center; margin-top:48px; color:var(--vscode-descriptionForeground); }
.add-btn { background:var(--vscode-button-background); color:var(--vscode-button-foreground); border:none; padding:6px 16px; cursor:pointer; border-radius:2px; font-size:var(--vscode-font-size); }
.add-btn:hover { background:var(--vscode-button-hoverBackground); }
.conn-row { display:flex; align-items:center; justify-content:space-between; padding:10px 12px; margin-bottom:4px; border-radius:4px; border:1px solid var(--vscode-panel-border); }
.conn-row:hover { background:var(--vscode-list-hoverBackground); }
.conn-info { display:flex; align-items:center; gap:10px; flex:1; min-width:0; }
.conn-icon { font-size:20px; }
.conn-details { flex:1; min-width:0; }
.conn-name { font-weight:600; font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.conn-meta { font-size:12px; color:var(--vscode-descriptionForeground); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:2px; }
.conn-actions { display:flex; gap:6px; flex-shrink:0; }
.action-btn { background:none; border:1px solid var(--vscode-panel-border); cursor:pointer; padding:4px 8px; border-radius:3px; font-size:14px; opacity:0.7; transition:opacity 0.15s; }
.action-btn:hover { opacity:1; background:var(--vscode-list-hoverBackground); }
.proxy-tag { display:inline-block; font-size:10px; font-weight:600; padding:1px 5px; border-radius:3px; background:var(--vscode-button-background); color:var(--vscode-button-foreground); vertical-align:middle; margin-left:4px; }
</style>
</head>
<body>
<div class="header">
  <span class="header-title">⚙️ ${t('wv_settings_title')}</span>
  <div>
    <button class="add-btn" id="addBtn">+ ${t('wv_settings_add')}</button>
  </div>
</div>
${rows}
<script>
const vscodeApi = acquireVsCodeApi();
document.getElementById('addBtn').addEventListener('click', () => vscodeApi.postMessage({ type: 'add' }));
document.querySelectorAll('.edit-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const id = btn.closest('.conn-row').dataset.id;
    vscodeApi.postMessage({ type: 'edit', connectionId: id });
  });
});
document.querySelectorAll('.delete-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const id = btn.closest('.conn-row').dataset.id;
    vscodeApi.postMessage({ type: 'delete', connectionId: id });
  });
});
</script>
</body>
</html>`;
}

function getFormHtml(data: Partial<HdfsConnection>, isEdit: boolean, backSvg: string): string {
  const name = data.name || '';
  const protocol = data.protocol || 'http';
  const host = data.host || '';
  const port = data.port ?? 50070;
  const authMethod = data.authMethod || 'SIMPLE';
  const username = data.username || '';
  const curlPath = data.curlPath || 'curl';
  const principal = data.principal || '';
  const keytabPath = data.keytabPath || '';
  const realm = data.realm || '';
  const kdc = data.kdc || '';
  const insecure = data.insecure ?? false;
  const delegationToken = data.delegationToken || '';

  return `<!DOCTYPE html>
<html lang="${isZh() ? 'zh-CN' : 'en'}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
body { margin:0; padding:16px; font-family:var(--vscode-font-family); font-size:var(--vscode-font-size); color:var(--vscode-foreground); background:var(--vscode-editor-background); }
.header { display:flex; align-items:center; gap:12px; margin-bottom:20px; }
.header-title { font-size:18px; font-weight:600; }
.back-btn { background:none; border:1px solid var(--vscode-panel-border); cursor:pointer; padding:4px 10px; border-radius:3px; line-height:0; color:var(--vscode-foreground); }
.back-btn:hover { background:var(--vscode-list-hoverBackground); }
.back-btn svg { width:18px; height:18px; display:block; }
.field-group { margin-bottom:14px; }
label { display:block; font-size:12px; font-weight:600; margin-bottom:4px; color:var(--vscode-descriptionForeground); }
input, select, textarea { width:100%; box-sizing:border-box; padding:6px 8px; border:1px solid var(--vscode-input-border); border-radius:2px; background:var(--vscode-input-background); color:var(--vscode-input-foreground); font-size:var(--vscode-font-size); font-family:var(--vscode-font-family); }
input:focus, select:focus, textarea:focus { outline:none; border-color:var(--vscode-focusBorder); }
textarea { resize:vertical; min-height:60px; }
.hint { font-size:11px; color:var(--vscode-descriptionForeground); margin-top:2px; opacity:0.7; }
.checkbox-row { display:flex; align-items:center; gap:8px; margin:14px 0; }
.checkbox-row input { width:auto; }
.checkbox-row label { margin:0;font-size:var(--vscode-font-size);cursor:pointer; }
.actions { display:flex; gap:8px; margin-top:20px; }
.btn-primary { background:var(--vscode-button-background); color:var(--vscode-button-foreground); border:none; padding:8px 20px; cursor:pointer; border-radius:2px; font-size:var(--vscode-font-size); }
.btn-primary:hover { background:var(--vscode-button-hoverBackground); }
.btn-secondary { background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground); border:none; padding:8px 20px; cursor:pointer; border-radius:2px; font-size:var(--vscode-font-size); }
.btn-secondary:hover { background:var(--vscode-button-secondaryHoverBackground); }
.btn-test { background:none; border:1px solid var(--vscode-panel-border); color:var(--vscode-foreground); padding:8px 20px; cursor:pointer; border-radius:2px; font-size:var(--vscode-font-size); }
.btn-test:hover { background:var(--vscode-list-hoverBackground); }
</style>
</head>
<body>
<div class="header">
  <button class="back-btn" id="backBtn">${backSvg}</button>
  <span class="header-title">${isEdit ? t('wv_settings_edit_title') : t('wv_settings_add_title')}</span>
</div>
<form id="connForm">
  <div class="field-group">
    <label for="name">${t('prompt_connectionName')}</label>
    <input type="text" id="name" value="${escapeHtml(name)}" placeholder="${t('prompt_connectionName_placeholder')}" required>
  </div>
  <div class="field-group">
    <label for="protocol">${t('prompt_protocol')}</label>
    <select id="protocol">
      <option value="http" ${protocol === 'http' ? 'selected' : ''}>${t('prompt_protocol_http')} — ${t('prompt_protocol_http_desc')}</option>
      <option value="https" ${protocol === 'https' ? 'selected' : ''}>${t('prompt_protocol_https')} — ${t('prompt_protocol_https_desc')}</option>
    </select>
  </div>
  <div class="field-group">
    <label for="host">${t('prompt_host')}</label>
    <input type="text" id="host" value="${escapeHtml(host)}" placeholder="${t('prompt_host_placeholder')}" required>
  </div>
  <div class="field-group">
    <label for="port">${t('prompt_port')} <span id="portHint" style="font-weight:normal;font-size:11px;color:var(--vscode-descriptionForeground);"></span></label>
    <input type="number" id="port" value="${port}" placeholder="${t('prompt_port_placeholder')}" required>
  </div>
  <div class="field-group">
    <label for="authMethod">${t('prompt_authMethod')}</label>
    <select id="authMethod">
      <option value="SIMPLE" ${authMethod === 'SIMPLE' ? 'selected' : ''}>${t('prompt_authMethod_simple')} — ${t('prompt_authMethod_simple_desc')}</option>
      <option value="KERBEROS" ${authMethod === 'KERBEROS' ? 'selected' : ''}>${t('prompt_authMethod_kerberos')} — ${t('prompt_authMethod_kerberos_desc')}</option>
      <option value="CURL_KERBEROS" ${authMethod === 'CURL_KERBEROS' ? 'selected' : ''}>CURL_KERBEROS — ${t('prompt_authMethod_curlkerberos_desc')}</option>
      <option value="TOKEN" ${authMethod === 'TOKEN' ? 'selected' : ''}>TOKEN — Delegation Token / Bearer token</option>
    </select>
  </div>
  <div class="field-group" id="usernameGroup" style="${authMethod === 'KERBEROS' || authMethod === 'CURL_KERBEROS' || authMethod === 'TOKEN' ? 'display:none;' : ''}">
    <label for="username">${t('prompt_username')}</label>
    <input type="text" id="username" value="${escapeHtml(username)}" placeholder="${t('prompt_username_placeholder')}">
  </div>
  <div class="field-group" id="curlGroup" style="${authMethod === 'CURL_KERBEROS' ? '' : 'display:none;'}">
    <label for="curlPath">${t('prompt_curlPath')}</label>
    <input type="text" id="curlPath" value="${escapeHtml(curlPath)}" placeholder="${t('prompt_curlPath_placeholder')}">
  </div>
  <div class="field-group" id="principalGroup" style="${authMethod === 'KERBEROS' ? '' : 'display:none;'}">
    <label for="principal">${t('prompt_principal')}</label>
    <input type="text" id="principal" value="${escapeHtml(principal)}" placeholder="${t('prompt_principal_placeholder')}">
    <div class="hint">${t('prompt_principal_hint')}</div>
  </div>
  <div class="field-group" id="keytabGroup" style="${authMethod === 'KERBEROS' ? '' : 'display:none;'}">
    <label for="keytabPath">${t('prompt_keytabPath')}</label>
    <input type="text" id="keytabPath" value="${escapeHtml(keytabPath)}" placeholder="${t('prompt_keytabPath_placeholder')}">
    <div class="hint">${t('prompt_keytabPath_hint')}</div>
  </div>
  <div class="field-group" id="realmGroup" style="${authMethod === 'KERBEROS' ? '' : 'display:none;'}">
    <label for="realm">${t('prompt_realm')}</label>
    <input type="text" id="realm" value="${escapeHtml(realm)}" placeholder="${t('prompt_realm_placeholder')}">
    <div class="hint">${t('prompt_realm_hint')}</div>
  </div>
  <div class="field-group" id="kdcGroup" style="${authMethod === 'KERBEROS' ? '' : 'display:none;'}">
    <label for="kdc">${t('prompt_kdc')}</label>
    <input type="text" id="kdc" value="${escapeHtml(kdc)}" placeholder="${t('prompt_kdc_placeholder')}">
    <div class="hint">${t('prompt_kdc_hint')}</div>
  </div>
  <div class="field-group" id="tokenGroup" style="${authMethod === 'TOKEN' ? '' : 'display:none;'}">
    <label for="delegationToken">Delegation Token / Bearer Token</label>
    <textarea id="delegationToken" placeholder="Paste delegation token here...">${escapeHtml(delegationToken)}</textarea>
    <div class="hint">${t('prompt_token_hint')}</div>
  </div>
  <div class="checkbox-row">
    <input type="checkbox" id="insecure" ${insecure ? 'checked' : ''}>
    <label for="insecure">${t('prompt_insecure')}</label>
  </div>
  <div class="actions">
    <button type="submit" class="btn-primary">${t('wv_settings_save')}</button>
    <button type="button" class="btn-test" id="testBtn">${t('wv_settings_test')}</button>
    <button type="button" class="btn-secondary" id="cancelBtn">${t('wv_settings_cancel')}</button>
  </div>
</form>
<script>
const vscodeApi = acquireVsCodeApi();
document.getElementById('backBtn').addEventListener('click', () => vscodeApi.postMessage({ type: 'cancel' }));
document.getElementById('cancelBtn').addEventListener('click', () => vscodeApi.postMessage({ type: 'cancel' }));
document.getElementById('testBtn').addEventListener('click', () => {
  vscodeApi.postMessage({ type: 'test', data: getFormData() });
});
document.getElementById('connForm').addEventListener('submit', e => {
  e.preventDefault();
  vscodeApi.postMessage({ type: 'save', data: getFormData() });
});
document.getElementById('authMethod').addEventListener('change', function() {
  const v = this.value;
  document.getElementById('usernameGroup').style.display = (v === 'KERBEROS' || v === 'CURL_KERBEROS' || v === 'TOKEN') ? 'none' : '';
  document.getElementById('curlGroup').style.display = v === 'CURL_KERBEROS' ? '' : 'none';
  document.getElementById('principalGroup').style.display = v === 'KERBEROS' ? '' : 'none';
  document.getElementById('keytabGroup').style.display = v === 'KERBEROS' ? '' : 'none';
  document.getElementById('realmGroup').style.display = v === 'KERBEROS' ? '' : 'none';
  document.getElementById('kdcGroup').style.display = v === 'KERBEROS' ? '' : 'none';
  document.getElementById('tokenGroup').style.display = v === 'TOKEN' ? '' : 'none';
  if (v !== 'TOKEN') document.getElementById('delegationToken').value = '';
  if (v !== 'CURL_KERBEROS') document.getElementById('curlPath').value = 'curl';
  if (v !== 'KERBEROS') {
    document.getElementById('principal').value = '';
    document.getElementById('keytabPath').value = '';
    document.getElementById('realm').value = '';
    document.getElementById('kdc').value = '';
  }
});
function getFormData() {
  const authMethod = document.getElementById('authMethod').value;
  const data = {
    name: document.getElementById('name').value.trim(),
    protocol: document.getElementById('protocol').value,
    host: document.getElementById('host').value.trim(),
    port: parseInt(document.getElementById('port').value) || (document.getElementById('protocol').value === 'https' ? 50470 : 50070),
    authMethod: authMethod,
    username: document.getElementById('username').value.trim(),
    curlPath: document.getElementById('curlPath').value.trim() || 'curl',
    principal: document.getElementById('principal').value.trim(),
    keytabPath: document.getElementById('keytabPath').value.trim(),
    realm: document.getElementById('realm').value.trim(),
    kdc: document.getElementById('kdc').value.trim(),
    insecure: document.getElementById('insecure').checked,
  };
  if (authMethod === 'TOKEN') data.delegationToken = document.getElementById('delegationToken').value.trim();
  return data;
}
</script>
</body>
</html>`;
}
