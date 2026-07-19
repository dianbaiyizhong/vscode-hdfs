package com.vscode.hdfs.service;

import com.vscode.hdfs.model.ContentSummary;
import com.vscode.hdfs.model.FileStatus;
import com.vscode.hdfs.model.HdfsSession;
import org.apache.hadoop.conf.Configuration;
import org.apache.hadoop.fs.FileSystem;
import org.apache.hadoop.security.UserGroupInformation;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

@Service
public class HdfsService {

    private static final Logger log = LoggerFactory.getLogger(HdfsService.class);

    private final SessionManager sessionManager;

    public HdfsService(SessionManager sessionManager) {
        this.sessionManager = sessionManager;
    }

    public FileSystem getFileSystem(HdfsSession session) throws IOException {
        Path confDir = session.getTempDir();
        Configuration conf = new Configuration();

        Path coreSite = confDir.resolve("core-site.xml");
        Path hdfsSite = confDir.resolve("hdfs-site.xml");

        if (Files.exists(coreSite)) {
            conf.addResource(new org.apache.hadoop.fs.Path(coreSite.toAbsolutePath().toString()));
        }
        if (Files.exists(hdfsSite)) {
            conf.addResource(new org.apache.hadoop.fs.Path(hdfsSite.toAbsolutePath().toString()));
        }

        Path krb5Conf = confDir.resolve("krb5.conf");
        if (Files.exists(krb5Conf)) {
            System.setProperty("java.security.krb5.conf", krb5Conf.toAbsolutePath().toString());
        }

        Path keytabPath = confDir.resolve("user.keytab");
        String principal = session.getPrincipal();

        if (principal != null && !principal.isBlank() && Files.exists(keytabPath)) {
            System.setProperty("hadoop.security.authentication", "kerberos");
            UserGroupInformation.setConfiguration(conf);
            UserGroupInformation.loginUserFromKeytab(principal, keytabPath.toAbsolutePath().toString());
        }

        return FileSystem.get(conf);
    }

    public List<FileStatus> listStatus(HdfsSession session, String path) throws IOException {
        FileSystem fs = getFileSystem(session);
        try {
            org.apache.hadoop.fs.FileStatus[] statuses = fs.listStatus(new org.apache.hadoop.fs.Path(path));
            List<FileStatus> result = new ArrayList<>();
            for (org.apache.hadoop.fs.FileStatus status : statuses) {
                result.add(new FileStatus(status));
            }
            return result;
        } finally {
            fs.close();
        }
    }

    public FileStatus getFileStatus(HdfsSession session, String path) throws IOException {
        FileSystem fs = getFileSystem(session);
        try {
            return new FileStatus(fs.getFileStatus(new org.apache.hadoop.fs.Path(path)));
        } finally {
            fs.close();
        }
    }

    public ContentSummary getContentSummary(HdfsSession session, String path) throws IOException {
        FileSystem fs = getFileSystem(session);
        try {
            return new ContentSummary(fs.getContentSummary(new org.apache.hadoop.fs.Path(path)));
        } finally {
            fs.close();
        }
    }

    public boolean mkdirs(HdfsSession session, String path) throws IOException {
        FileSystem fs = getFileSystem(session);
        try {
            return fs.mkdirs(new org.apache.hadoop.fs.Path(path));
        } finally {
            fs.close();
        }
    }

    public boolean delete(HdfsSession session, String path, boolean recursive) throws IOException {
        FileSystem fs = getFileSystem(session);
        try {
            return fs.delete(new org.apache.hadoop.fs.Path(path), recursive);
        } finally {
            fs.close();
        }
    }

    public boolean rename(HdfsSession session, String src, String dst) throws IOException {
        FileSystem fs = getFileSystem(session);
        try {
            return fs.rename(new org.apache.hadoop.fs.Path(src), new org.apache.hadoop.fs.Path(dst));
        } finally {
            fs.close();
        }
    }

    public byte[] readFile(HdfsSession session, String path) throws IOException {
        FileSystem fs = getFileSystem(session);
        try (var in = fs.open(new org.apache.hadoop.fs.Path(path));
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) != -1) {
                out.write(buf, 0, n);
            }
            return out.toByteArray();
        } finally {
            fs.close();
        }
    }

    public void writeFile(HdfsSession session, String path, byte[] content) throws IOException {
        FileSystem fs = getFileSystem(session);
        try (var out = fs.create(new org.apache.hadoop.fs.Path(path), true)) {
            out.write(content);
        } finally {
            fs.close();
        }
    }

    public boolean testConnection(HdfsSession session) throws IOException {
        try {
            FileSystem fs = getFileSystem(session);
            try {
                fs.getFileStatus(new org.apache.hadoop.fs.Path("/"));
                return true;
            } finally {
                fs.close();
            }
        } catch (Exception e) {
            log.warn("Connection test failed for session {}: {}", session.getSessionId(), e.getMessage());
            return false;
        }
    }
}
