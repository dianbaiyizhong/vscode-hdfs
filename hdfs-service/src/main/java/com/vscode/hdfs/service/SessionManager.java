package com.vscode.hdfs.service;

import com.vscode.hdfs.model.HdfsSession;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

@Service
public class SessionManager {

    private static final Logger log = LoggerFactory.getLogger(SessionManager.class);

    private final Map<String, HdfsSession> sessions = new ConcurrentHashMap<>();

    @Value("${app.temp-dir-prefix}")
    private String tempDirPrefix;

    @Value("${app.session-timeout-minutes}")
    private long sessionTimeoutMinutes;

    public HdfsSession createSession() throws IOException {
        String sessionId = UUID.randomUUID().toString();
        Path tempDir = Files.createTempDirectory(tempDirPrefix + sessionId);
        HdfsSession session = new HdfsSession(sessionId, tempDir);
        sessions.put(sessionId, session);
        log.info("Created session: {}", sessionId);
        return session;
    }

    public HdfsSession getSession(String sessionId) {
        HdfsSession session = sessions.get(sessionId);
        if (session == null) {
            return null;
        }
        session.touch();
        return session;
    }

    public void removeSession(String sessionId) {
        HdfsSession session = sessions.remove(sessionId);
        if (session != null) {
            deleteDirectory(session.getTempDir());
            log.info("Removed session: {}", sessionId);
        }
    }

    public void cleanupExpiredSessions() {
        long now = System.currentTimeMillis();
        long timeoutMs = sessionTimeoutMinutes * 60 * 1000;
        sessions.values().removeIf(session -> {
            if (now - session.getLastAccessedAt() > timeoutMs) {
                deleteDirectory(session.getTempDir());
                log.info("Cleaned up expired session: {}", session.getSessionId());
                return true;
            }
            return false;
        });
    }

    private void deleteDirectory(Path dir) {
        try {
            try (var paths = Files.walk(dir)) {
                paths.sorted(java.util.Comparator.reverseOrder())
                     .forEach(p -> {
                         try {
                             Files.deleteIfExists(p);
                         } catch (IOException e) {
                             log.warn("Failed to delete: {}", p, e);
                         }
                     });
            }
        } catch (IOException e) {
            log.warn("Failed to walk directory: {}", dir, e);
        }
    }

    @PreDestroy
    public void shutdown() {
        sessions.keySet().forEach(this::removeSession);
    }
}
