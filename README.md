# HDFS Explorer

A VS Code extension for browsing, viewing, and managing HDFS files and directories with CRUD operations and Kerberos authentication.

## Architecture

The extension consists of two components:

- **VS Code Extension** (TypeScript) — provides the HDFS Explorer tree view, folder browser webview, and connection management UI.
- **HDFS Middleware Service** (Spring Boot 3 / Java 17) — a REST API bridge between the extension and your HDFS cluster. The extension communicates with this service over HTTP.

## Prerequisites

- **VS Code** ^1.80.0
- **Node.js** (LTS) and **npm**
- **Java 17+**
- **Maven 3.8+** (for building the service)
- A running **HDFS cluster** (Hadoop 3.x)

## Quick Start

### 1. Start the HDFS Middleware Service

```bash
cd hdfs-service

# Build (first time only)
mvn package -DskipTests

# Run
java -jar target/hdfs-service-1.0.0.jar
```

The service starts on `http://localhost:8899` by default. Edit `src/main/resources/application.yml` to change the port or other settings.

### 2. Install and Run the VS Code Extension

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile
```

Then press **F5** in VS Code to launch the Extension Development Host, or package the extension:

```bash
npm install -g @vscode/vsce
vsce package
code --install-extension vscode-hdfs-0.3.0.vsix
```

### 3. Configure a Connection

1. Click the **HDFS Explorer** icon in the Activity Bar.
2. Click **New Connection** (the `+` icon).
3. Fill in:
   - **Name** — any friendly name
   - **Service URL** — URL of the middleware service (e.g., `http://localhost:8899`)
   - **Auth Method** — `SIMPLE` or `KERBEROS`

For Kerberos, you will also need to provide:
- Principal (e.g., `hdfs/node@REALM`)
- Paths to `core-site.xml`, `hdfs-site.xml`, `krb5.conf`, and keytab file

## Configuration

### Middleware Service (`hdfs-service/src/main/resources/application.yml`)

| Property | Default | Description |
|---|---|---|
| `server.port` | `8899` | HTTP port |
| `spring.servlet.multipart.max-file-size` | `100MB` | Max upload file size |
| `spring.servlet.multipart.max-request-size` | `200MB` | Max upload request size |
| `app.temp-dir-prefix` | `vscode-hdfs-` | Prefix for per-session temp directories |
| `app.session-timeout-minutes` | `60` | Session idle timeout in minutes |

## Usage

- **Browse** — click a connection in the sidebar to open the folder browser webview
- **Create** — right-click a directory → **New Folder**
- **Upload** — right-click a directory → **Upload File**, or drag-and-drop files into the webview
- **Download** — right-click a file → **Download**
- **Delete** — right-click a file/folder → **Delete**
- **Rename** — right-click a file/folder → **Rename**
- **Open** — click a file to view its contents in a VS Code editor
- **Settings** — click the gear icon to manage connections
- **Task View** — click the checklist icon to monitor upload/download progress

## Build from Source

```bash
# Extension
npm install
npm run compile

# Service
cd hdfs-service
mvn package -DskipTests
```

## License

MIT
