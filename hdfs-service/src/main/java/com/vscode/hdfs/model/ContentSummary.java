package com.vscode.hdfs.model;

public class ContentSummary {
    private long directoryCount;
    private long fileCount;
    private long length;
    private long quota;
    private long spaceConsumed;
    private long spaceQuota;

    public ContentSummary() {}

    public ContentSummary(org.apache.hadoop.fs.ContentSummary cs) {
        this.directoryCount = cs.getDirectoryCount();
        this.fileCount = cs.getFileCount();
        this.length = cs.getLength();
        this.quota = cs.getQuota();
        this.spaceConsumed = cs.getSpaceConsumed();
        this.spaceQuota = cs.getSpaceQuota();
    }

    public long getDirectoryCount() { return directoryCount; }
    public void setDirectoryCount(long directoryCount) { this.directoryCount = directoryCount; }
    public long getFileCount() { return fileCount; }
    public void setFileCount(long fileCount) { this.fileCount = fileCount; }
    public long getLength() { return length; }
    public void setLength(long length) { this.length = length; }
    public long getQuota() { return quota; }
    public void setQuota(long quota) { this.quota = quota; }
    public long getSpaceConsumed() { return spaceConsumed; }
    public void setSpaceConsumed(long spaceConsumed) { this.spaceConsumed = spaceConsumed; }
    public long getSpaceQuota() { return spaceQuota; }
    public void setSpaceQuota(long spaceQuota) { this.spaceQuota = spaceQuota; }
}
