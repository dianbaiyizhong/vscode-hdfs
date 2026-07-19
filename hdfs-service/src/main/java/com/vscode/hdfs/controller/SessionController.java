package com.vscode.hdfs.controller;

import com.vscode.hdfs.model.HdfsSession;
import com.vscode.hdfs.service.HdfsService;
import com.vscode.hdfs.service.SessionManager;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

@RestController
@RequestMapping("/api/session")
public class SessionController {

    private static final Logger log = LoggerFactory.getLogger(SessionController.class);

    private final SessionManager sessionManager;
    private final HdfsService hdfsService;

    public SessionController(SessionManager sessionManager, HdfsService hdfsService) {
        this.sessionManager = sessionManager;
        this.hdfsService = hdfsService;
    }

    @PostMapping
    public ResponseEntity<Map<String, Object>> createSession(
            @RequestParam("coreSite") MultipartFile coreSite,
            @RequestParam("hdfsSite") MultipartFile hdfsSite,
            @RequestParam(value = "krb5Conf", required = false) MultipartFile krb5Conf,
            @RequestParam(value = "keytab", required = false) MultipartFile keytab,
            @RequestParam(value = "principal", required = false) String principal) throws IOException {

        HdfsSession session = sessionManager.createSession();
        Path tempDir = session.getTempDir();

        coreSite.transferTo(tempDir.resolve("core-site.xml").toFile());
        hdfsSite.transferTo(tempDir.resolve("hdfs-site.xml").toFile());

        if (krb5Conf != null && !krb5Conf.isEmpty()) {
            krb5Conf.transferTo(tempDir.resolve("krb5.conf").toFile());
        }

        if (keytab != null && !keytab.isEmpty()) {
            keytab.transferTo(tempDir.resolve("user.keytab").toFile());
        }

        if (principal != null && !principal.isBlank()) {
            session.setPrincipal(principal);
        }

        log.info("Session {} created with principal={}", session.getSessionId(), principal);

        Map<String, Object> response = new HashMap<>();
        response.put("sessionId", session.getSessionId());
        response.put("principal", principal);

        return ResponseEntity.ok(response);
    }

    @DeleteMapping("/{sessionId}")
    public ResponseEntity<Map<String, String>> deleteSession(@PathVariable String sessionId) {
        sessionManager.removeSession(sessionId);
        Map<String, String> response = new HashMap<>();
        response.put("message", "Session deleted");
        return ResponseEntity.ok(response);
    }

    @PostMapping("/{sessionId}/test")
    public ResponseEntity<Map<String, Object>> testConnection(@PathVariable String sessionId) {
        HdfsSession session = sessionManager.getSession(sessionId);
        if (session == null) {
            return ResponseEntity.status(404).body(Map.of("error", "Session not found"));
        }
        try {
            boolean connected = hdfsService.testConnection(session);
            return ResponseEntity.ok(Map.of("connected", connected));
        } catch (IOException e) {
            return ResponseEntity.ok(Map.of("connected", false, "error", e.getMessage()));
        }
    }
}
