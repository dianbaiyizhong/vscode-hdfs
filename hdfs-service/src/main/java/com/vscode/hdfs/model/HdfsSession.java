package com.vscode.hdfs.model;

import java.nio.file.Path;

public class HdfsSession {
    private String sessionId;
    private Path tempDir;
    private long createdAt;
    private long lastAccessedAt;
    private String principal;

    public HdfsSession(String sessionId, Path tempDir) {
        this.sessionId = sessionId;
        this.tempDir = tempDir;
        this.createdAt = System.currentTimeMillis();
        this.lastAccessedAt = this.createdAt;
    }

    public String getSessionId() { return sessionId; }
    public void setSessionId(String sessionId) { this.sessionId = sessionId; }
    public Path getTempDir() { return tempDir; }
    public void setTempDir(Path tempDir) { this.tempDir = tempDir; }
    public long getCreatedAt() { return createdAt; }
    public void setCreatedAt(long createdAt) { this.createdAt = createdAt; }
    public long getLastAccessedAt() { return lastAccessedAt; }
    public void setLastAccessedAt(long lastAccessedAt) { this.lastAccessedAt = lastAccessedAt; }
    public String getPrincipal() { return principal; }
    public void setPrincipal(String principal) { this.principal = principal; }

    public void touch() { this.lastAccessedAt = System.currentTimeMillis(); }
}
