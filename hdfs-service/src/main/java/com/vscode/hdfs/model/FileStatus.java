package com.vscode.hdfs.model;

public class FileStatus {
    private String pathSuffix;
    private String type;
    private long length;
    private long modificationTime;
    private String permission;
    private String owner;
    private String group;
    private long replication;
    private long blockSize;

    public FileStatus() {}

    public FileStatus(org.apache.hadoop.fs.FileStatus fs) {
        this.pathSuffix = fs.getPath().getName();
        this.type = fs.isDirectory() ? "DIRECTORY" : "FILE";
        this.length = fs.getLen();
        this.modificationTime = fs.getModificationTime();
        this.permission = fs.getPermission().toString();
        this.owner = fs.getOwner();
        this.group = fs.getGroup();
        this.replication = fs.getReplication();
        this.blockSize = fs.getBlockSize();
    }

    public String getPathSuffix() { return pathSuffix; }
    public void setPathSuffix(String pathSuffix) { this.pathSuffix = pathSuffix; }
    public String getType() { return type; }
    public void setType(String type) { this.type = type; }
    public long getLength() { return length; }
    public void setLength(long length) { this.length = length; }
    public long getModificationTime() { return modificationTime; }
    public void setModificationTime(long modificationTime) { this.modificationTime = modificationTime; }
    public String getPermission() { return permission; }
    public void setPermission(String permission) { this.permission = permission; }
    public String getOwner() { return owner; }
    public void setOwner(String owner) { this.owner = owner; }
    public String getGroup() { return group; }
    public void setGroup(String group) { this.group = group; }
    public long getReplication() { return replication; }
    public void setReplication(long replication) { this.replication = replication; }
    public long getBlockSize() { return blockSize; }
    public void setBlockSize(long blockSize) { this.blockSize = blockSize; }
}
