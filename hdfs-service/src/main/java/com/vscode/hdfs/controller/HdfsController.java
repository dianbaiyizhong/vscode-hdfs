package com.vscode.hdfs.controller;

import com.vscode.hdfs.model.ContentSummary;
import com.vscode.hdfs.model.FileStatus;
import com.vscode.hdfs.model.HdfsSession;
import com.vscode.hdfs.service.HdfsService;
import com.vscode.hdfs.service.SessionManager;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/hdfs")
public class HdfsController {

    private final HdfsService hdfsService;
    private final SessionManager sessionManager;

    public HdfsController(HdfsService hdfsService, SessionManager sessionManager) {
        this.hdfsService = hdfsService;
        this.sessionManager = sessionManager;
    }

    private HdfsSession getSession(String sessionId) {
        HdfsSession session = sessionManager.getSession(sessionId);
        if (session == null) {
            throw new SessionNotFoundException("Session not found: " + sessionId);
        }
        return session;
    }

    @GetMapping("/list")
    public ResponseEntity<List<FileStatus>> listStatus(
            @RequestParam String sessionId,
            @RequestParam(defaultValue = "/") String path) throws IOException {
        return ResponseEntity.ok(hdfsService.listStatus(getSession(sessionId), path));
    }

    @GetMapping("/status")
    public ResponseEntity<FileStatus> getFileStatus(
            @RequestParam String sessionId,
            @RequestParam(defaultValue = "/") String path) throws IOException {
        return ResponseEntity.ok(hdfsService.getFileStatus(getSession(sessionId), path));
    }

    @GetMapping("/summary")
    public ResponseEntity<ContentSummary> getContentSummary(
            @RequestParam String sessionId,
            @RequestParam(defaultValue = "/") String path) throws IOException {
        return ResponseEntity.ok(hdfsService.getContentSummary(getSession(sessionId), path));
    }

    @PostMapping("/mkdir")
    public ResponseEntity<Map<String, Object>> mkdirs(
            @RequestParam String sessionId,
            @RequestParam String path) throws IOException {
        boolean result = hdfsService.mkdirs(getSession(sessionId), path);
        return ResponseEntity.ok(Map.of("success", result));
    }

    @DeleteMapping("/delete")
    public ResponseEntity<Map<String, Object>> delete(
            @RequestParam String sessionId,
            @RequestParam String path,
            @RequestParam(defaultValue = "true") boolean recursive) throws IOException {
        boolean result = hdfsService.delete(getSession(sessionId), path, recursive);
        return ResponseEntity.ok(Map.of("success", result));
    }

    @PostMapping("/rename")
    public ResponseEntity<Map<String, Object>> rename(
            @RequestParam String sessionId,
            @RequestParam String path,
            @RequestParam String destination) throws IOException {
        boolean result = hdfsService.rename(getSession(sessionId), path, destination);
        return ResponseEntity.ok(Map.of("success", result));
    }

    @GetMapping("/read")
    public ResponseEntity<byte[]> readFile(
            @RequestParam String sessionId,
            @RequestParam String path) throws IOException {
        byte[] data = hdfsService.readFile(getSession(sessionId), path);
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_OCTET_STREAM_VALUE)
                .body(data);
    }

    @PostMapping("/write")
    public ResponseEntity<Map<String, Object>> writeFile(
            @RequestParam String sessionId,
            @RequestParam String path,
            @RequestParam("file") MultipartFile file) throws IOException {
        hdfsService.writeFile(getSession(sessionId), path, file.getBytes());
        return ResponseEntity.ok(Map.of("success", true));
    }

    @ExceptionHandler(SessionNotFoundException.class)
    public ResponseEntity<Map<String, String>> handleSessionNotFound(SessionNotFoundException e) {
        return ResponseEntity.status(404).body(Map.of("error", e.getMessage()));
    }

    @ExceptionHandler(IOException.class)
    public ResponseEntity<Map<String, String>> handleIoException(IOException e) {
        return ResponseEntity.status(500).body(Map.of("error", e.getMessage()));
    }

    private static class SessionNotFoundException extends RuntimeException {
        public SessionNotFoundException(String message) {
            super(message);
        }
    }
}
