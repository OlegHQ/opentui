const std = @import("std");
const builtin = @import("builtin");
const kitty = @import("../kitty-transport.zig");
const image = @import("../image.zig");

const FileIo = struct {
    clocks: u32 = 0,
    created: u32 = 0,
    closed: u32 = 0,
    removed: u32 = 0,
    writes: u32 = 0,
    fail_write: bool = false,
    fail_remove: bool = false,
    time_ns: i96 = 0,

    fn io(self: *FileIo) std.Io {
        return .{ .userdata = self, .vtable = &vtable };
    }

    const vtable: std.Io.VTable = blk: {
        var value = std.Io.failing.vtable.*;
        value.now = now;
        value.dirCreateFile = create;
        value.dirOpenFile = open;
        value.fileClose = close;
        value.dirDeleteFile = remove;
        value.operate = operate;
        value.randomSecure = random;
        break :blk value;
    };

    fn now(data: ?*anyopaque, _: std.Io.Clock) std.Io.Timestamp {
        const self: *FileIo = @ptrCast(@alignCast(data.?));
        self.clocks += 1;
        return .{ .nanoseconds = self.time_ns };
    }

    fn create(data: ?*anyopaque, dir: std.Io.Dir, path: []const u8, options: std.Io.Dir.CreateFileOptions) std.Io.File.OpenError!std.Io.File {
        const self: *FileIo = @ptrCast(@alignCast(data.?));
        self.created += 1;
        return std.testing.io.vtable.dirCreateFile(std.testing.io.userdata, dir, path, options);
    }

    fn open(_: ?*anyopaque, dir: std.Io.Dir, path: []const u8, options: std.Io.Dir.OpenFileOptions) std.Io.File.OpenError!std.Io.File {
        return std.testing.io.vtable.dirOpenFile(std.testing.io.userdata, dir, path, options);
    }

    fn close(data: ?*anyopaque, files: []const std.Io.File) void {
        const self: *FileIo = @ptrCast(@alignCast(data.?));
        self.closed += @intCast(files.len);
        std.testing.io.vtable.fileClose(std.testing.io.userdata, files);
    }

    fn remove(data: ?*anyopaque, dir: std.Io.Dir, path: []const u8) std.Io.Dir.DeleteFileError!void {
        const self: *FileIo = @ptrCast(@alignCast(data.?));
        self.removed += 1;
        if (self.fail_remove) return error.AccessDenied;
        return std.testing.io.vtable.dirDeleteFile(std.testing.io.userdata, dir, path);
    }

    fn operate(data: ?*anyopaque, operation: std.Io.Operation) std.Io.Cancelable!std.Io.Operation.Result {
        const self: *FileIo = @ptrCast(@alignCast(data.?));
        if (operation == .file_write_streaming) {
            self.writes += 1;
            if (self.fail_write) return .{ .file_write_streaming = error.InputOutput };
        }
        return std.testing.io.operate(operation);
    }

    fn random(_: ?*anyopaque, bytes: []u8) std.Io.RandomSecureError!void {
        return std.testing.io.randomSecure(bytes);
    }
};

test "Session Kitty files use Context I/O for creation writes and cleanup" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;
    var supplied: FileIo = .{};
    const f = try @import("session-terminal_test.zig").Fixture.init(std.testing.allocator, supplied.io(), 2, 1);
    defer f.deinit();
    f.cli.terminal.graphics_enabled = true;
    try f.owner.setupSessionTerminal(f.id, .{});
    var now_ns: u64 = 100;
    try f.drive(&now_ns, .active);
    try f.value.setKittyImageTransport(2);
    try std.testing.expectEqual(.probing, f.cli.kittyTransport.file_state);
    try std.testing.expectEqual(@as(u32, 1), supplied.created);
    try std.testing.expectEqual(@as(u32, 1), supplied.writes);
    try std.testing.expectEqual(@as(u32, if (builtin.os.tag == .linux) 2 else 1), supplied.closed);
    try f.value.cancelKittyImageTransport(false);
    try std.testing.expectEqual(@as(u32, 1), supplied.removed);
    try std.testing.expectEqual(@as(u32, 0), f.cli.kittyTransport.pendingCount());
}

test "Session Kitty expiry follows host pump time while terminal output is pending" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;
    var supplied: FileIo = .{};
    const f = try @import("session-terminal_test.zig").Fixture.init(std.testing.allocator, supplied.io(), 2, 1);
    defer f.deinit();
    f.cli.terminal.graphics_enabled = true;
    try f.owner.setupSessionTerminal(f.id, .{});
    var now_ns: u64 = 100;
    try f.drive(&now_ns, .active);
    try f.value.setKittyImageTransport(2);
    const clocks = supplied.clocks;
    try std.testing.expectEqual(.output_pending, (try f.owner.pumpSession(f.id, now_ns, 1)).status);
    const deadline = now_ns + 5 * std.time.ns_per_s;
    supplied.time_ns = std.math.maxInt(i96);
    _ = try f.owner.pumpSession(f.id, deadline - 1, 1);
    try std.testing.expectEqual(.probing, f.cli.kittyTransport.file_state);
    _ = try f.owner.pumpSession(f.id, deadline, 1);
    try std.testing.expectEqual(.timeout, f.cli.kittyTransport.file_state);
    try std.testing.expectEqual(@as(u32, 0), f.cli.kittyTransport.pendingCount());
    try std.testing.expectEqual(clocks, supplied.clocks);
}

test "Session Kitty polls share clock admission with pumps and arm after an idle host" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;
    var supplied: FileIo = .{};
    const f = try @import("session-terminal_test.zig").Fixture.init(std.testing.allocator, supplied.io(), 2, 1);
    defer f.deinit();
    f.cli.terminal.graphics_enabled = true;
    try f.owner.setupSessionTerminal(f.id, .{});
    var now_ns: u64 = 0;
    try f.drive(&now_ns, .active);
    try f.value.setKittyImageTransport(2);
    const clocks = supplied.clocks;
    now_ns = 100 * std.time.ns_per_s;
    _ = try f.owner.sessionPollKittyImageTransport(f.id, now_ns);
    try std.testing.expectEqual(.probing, f.cli.kittyTransport.file_state);
    try std.testing.expectError(error.InvalidClock, f.owner.pumpSession(f.id, now_ns - 1, 1));
    try std.testing.expectError(error.InvalidClock, f.owner.sessionPollKittyImageTransport(f.id, now_ns - 1));
    const deadline = now_ns + kitty.TIMEOUT_NS;
    try std.testing.expectError(error.InvalidBudget, f.owner.pumpSession(f.id, deadline, 0));
    try std.testing.expectEqual(now_ns, f.value.last_pump_ns.?);
    _ = try f.owner.pumpSession(f.id, now_ns, 1);
    _ = try f.owner.sessionPollKittyImageTransport(f.id, deadline - 1);
    try std.testing.expectEqual(.probing, f.cli.kittyTransport.file_state);
    _ = try f.owner.sessionPollKittyImageTransport(f.id, deadline);
    try std.testing.expectEqual(.timeout, f.cli.kittyTransport.file_state);
    try std.testing.expectEqual(@as(u32, 0), f.cli.kittyTransport.pendingCount());
    try std.testing.expectEqual(clocks, supplied.clocks);
}

test "Session Kitty file preparation closes files and uses injected failure cleanup" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;
    var supplied: FileIo = .{ .fail_write = true };
    const f = try @import("session-terminal_test.zig").Fixture.init(std.testing.allocator, supplied.io(), 2, 1);
    defer f.deinit();
    f.cli.terminal.graphics_enabled = true;
    try f.owner.setupSessionTerminal(f.id, .{});
    var now_ns: u64 = 0;
    try f.drive(&now_ns, .active);
    try f.value.setKittyImageTransport(2);
    try std.testing.expectEqual(.io_error, f.cli.kittyTransport.file_state);
    try std.testing.expectEqual(@as(u32, 1), supplied.created);
    try std.testing.expectEqual(@as(u32, 1), supplied.writes);
    try std.testing.expectEqual(@as(u32, if (builtin.os.tag == .linux) 2 else 1), supplied.closed);
    try std.testing.expectEqual(@as(u32, 1), supplied.removed);
    try std.testing.expectEqual(@as(u32, 0), f.cli.kittyTransport.pendingCount());
}

test "raw Kitty expiry starts at native file creation" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;
    var supplied: FileIo = .{};
    const f = try @import("session-terminal_test.zig").Fixture.init(std.testing.allocator, supplied.io(), 2, 1);
    defer f.deinit();
    f.cli.host_driven_time = false;
    f.cli.terminal.graphics_enabled = true;
    f.cli.kittyTransport.mode = .file;
    f.cli.startKittyFileProbeFromSession();
    try std.testing.expectEqual(.probing, f.cli.kittyTransport.file_state);
    supplied.time_ns = kitty.TIMEOUT_NS;
    _ = f.cli.pollKittyImageTransport();
    try std.testing.expectEqual(.timeout, f.cli.kittyTransport.file_state);
    try std.testing.expectEqual(@as(u32, 0), f.cli.kittyTransport.pendingCount());
}

const Fixture = struct {
    tmp: std.testing.TmpDir,
    directory: [512]u8 = undefined,
    directory_len: usize = 0,
    transport: kitty.Transport = .{ .io = std.testing.io, .mode = .file },
    output: std.Io.Writer.Allocating = .init(std.testing.allocator),

    fn init(self: *Fixture) !void {
        if (builtin.os.tag == .windows) return error.SkipZigTest;
        self.* = .{ .tmp = std.testing.tmpDir(.{ .iterate = true }) };
        errdefer self.tmp.cleanup();
        self.directory_len = try self.tmp.dir.realPath(std.testing.io, &self.directory);
    }

    fn deinit(self: *Fixture) void {
        self.transport.cancel(.cancelled);
        self.output.deinit();
        self.tmp.cleanup();
    }

    fn expectNoFiles(self: *Fixture) !void {
        var iterator = self.tmp.dir.iterate();
        try std.testing.expectEqual(null, try iterator.next(std.testing.io));
    }

    fn probe(self: *Fixture) !void {
        try self.transport.startProbe(&self.output.writer, 7, self.directory[0..self.directory_len]);
        self.transport.expire(0);
    }

    fn ready(self: *Fixture) !void {
        try self.probe();
        try std.testing.expect(self.transport.handleReply("\x1b_Gi=7;OK\x1b\\"));
        try std.testing.expect(self.transport.handleReply("\x1b_Gi=8;OK\x1b\\"));
        try std.testing.expectEqual(.ready, self.transport.file_state);
        self.transport.retry_images = false;
        self.output.clearRetainingCapacity();
    }

    fn transmit(self: *Fixture, value: *image.Image, id: u32) !void {
        try self.transport.transmit(std.testing.allocator, &self.output.writer, value, id, false, self.directory[0..self.directory_len]);
        self.transport.expire(0);
    }
};

test "kitty file query requires medium and explicit image ACK, not ordinary frame reports" {
    var f: Fixture = undefined;
    try f.init();
    defer f.deinit();
    try f.probe();
    try std.testing.expect(std.mem.find(u8, f.output.written(), "a=q,t=f") != null);
    try std.testing.expect(std.mem.find(u8, f.output.written(), "a=t,t=f") != null);
    try std.testing.expectEqual(@as(u32, 1), f.transport.pendingCount());
    try std.testing.expect(!f.transport.handleReply("\x1b[0n"));
    try std.testing.expect(!f.transport.handleReply("\x1b_Gi=31337;OK\x1b\\"));
    try std.testing.expect(!f.transport.handleReply("\x1b_Gi=7,i=8;OK\x1b\\"));
    try std.testing.expect(f.transport.handleReply("\x1b_Gi=7;OK\x1b\\"));
    try std.testing.expectEqual(.probing, f.transport.file_state);
    f.transport.expire(std.math.maxInt(u64));
    try std.testing.expectEqual(.timeout, f.transport.file_state);
    try std.testing.expectEqual(@as(u32, 0), f.transport.pendingCount());
    try f.expectNoFiles();
    try std.testing.expect(f.transport.handleReply("\x1b_Gi=8;OK\x1b\\"));
    try std.testing.expectEqual(.timeout, f.transport.file_state);
}

test "kitty file leases contain immutable bytes and are released only by matching ACK" {
    var f: Fixture = undefined;
    try f.init();
    defer f.deinit();
    try f.ready();
    const value = try image.createFromRgba(std.testing.allocator, &.{ 1, 2, 3, 255 }, 1, 1, 4);
    defer value.deinit();
    try f.transmit(value, 19);
    try std.testing.expectEqual(.file, f.transport.effective);
    const path = try @import("terminal-image_test.zig").decodeKittyChunks(f.output.written());
    defer std.testing.allocator.free(path);
    const contents = try std.Io.Dir.cwd().readFileAlloc(std.testing.io, path, std.testing.allocator, .limited(16));
    defer std.testing.allocator.free(contents);
    try std.testing.expectEqualSlices(u8, &.{ 1, 2, 3 }, contents);
    f.transport.mode = .raw;
    value.pixels[0] = 99;
    try f.transmit(value, 19);
    try std.testing.expectEqual(.raw, f.transport.effective);
    f.transport.mode = .file;
    try f.transmit(value, 19);
    try std.testing.expectEqual(.raw, f.transport.effective);
    try std.testing.expectEqual(.busy, f.transport.fallback);
    try std.testing.expectEqual(@as(u32, 1), f.transport.pendingCount());
    try std.testing.expect(!f.transport.handleReply("\x1b_Gi=190;OK\x1b\\"));
    const unchanged = try std.Io.Dir.cwd().readFileAlloc(std.testing.io, path, std.testing.allocator, .limited(16));
    defer std.testing.allocator.free(unchanged);
    try std.testing.expectEqualSlices(u8, contents, unchanged);
    f.transport.mode = .zlib;
    try std.testing.expect(f.transport.handleReply("\x1b_Gi=19;OK\x1b\\"));
    try std.testing.expectError(error.FileNotFound, std.Io.Dir.accessAbsolute(std.testing.io, path, .{}));
    try std.testing.expectEqual(@as(u32, 0), f.transport.pendingCount());
    try std.testing.expectEqual(.ready, f.transport.file_state);
    try std.testing.expect(!f.transport.retry_images);
}

test "kitty file probe readiness retries only images using the selected file mode" {
    for ([_]kitty.Mode{ .file, .raw, .zlib }) |mode| {
        var f: Fixture = undefined;
        try f.init();
        defer f.deinit();
        try f.probe();
        try std.testing.expect(f.transport.handleReply("\x1b_Gi=7;OK\x1b\\"));
        try std.testing.expect(!f.transport.retry_images);
        f.transport.mode = mode;
        try std.testing.expect(f.transport.handleReply("\x1b_Gi=8;OK\x1b\\"));
        try std.testing.expectEqual(.ready, f.transport.file_state);
        try std.testing.expectEqual(mode == .file, f.transport.retry_images);
        try f.expectNoFiles();
        f.transport.retry_images = false;
        try std.testing.expect(f.transport.handleReply("\x1b_Gi=8;OK\x1b\\"));
        try std.testing.expect(!f.transport.retry_images);
        f.transport.mode = .file;
        f.output.clearRetainingCapacity();
        try f.probe();
        try std.testing.expectEqual(@as(usize, 0), f.output.written().len);
    }
}

test "kitty file upload expiry cancels rather than reusing a late acknowledged lease" {
    var f: Fixture = undefined;
    try f.init();
    defer f.deinit();
    try f.ready();
    const value = try image.createFromRgba(std.testing.allocator, &.{ 1, 2, 3, 4 }, 1, 1, 4);
    defer value.deinit();
    try f.transmit(value, 19);
    var deadline: u64 = 0;
    for (f.transport.leases) |lease| if (lease.path_len != 0) {
        deadline = lease.deadline_ns.?;
    };
    f.transport.mode = .raw;
    f.transport.expire(deadline - 1);
    try std.testing.expectEqual(@as(u32, 1), f.transport.pendingCount());
    f.transport.expire(deadline);
    try std.testing.expectEqual(@as(u32, 0), f.transport.pendingCount());
    try f.expectNoFiles();
    try std.testing.expectEqual(.timeout, f.transport.file_state);
    try std.testing.expect(f.transport.retry_images);
    f.transport.mode = .file;
    f.output.clearRetainingCapacity();
    try f.probe();
    try std.testing.expectEqual(@as(usize, 0), f.output.written().len);
    try f.transmit(value, 19);
    try std.testing.expectEqual(.raw, f.transport.effective);
    try std.testing.expect(!f.transport.handleReply("\x1b_Gi=19;OK\x1b\\"));
    try std.testing.expectEqual(.timeout, f.transport.file_state);
}

test "kitty file slot budget falls back to raw and upload errors release all leases" {
    var f: Fixture = undefined;
    try f.init();
    defer f.deinit();
    try f.ready();
    const value = try image.createFromRgba(std.testing.allocator, &.{ 1, 2, 3, 4 }, 1, 1, 4);
    defer value.deinit();
    for (0..kitty.LEASES_MAX) |i| try f.transmit(value, @intCast(20 + i));
    try f.transmit(value, 100);
    try std.testing.expectEqual(.raw, f.transport.effective);
    try std.testing.expectEqual(.budget, f.transport.fallback);
    try std.testing.expectEqual(@as(u32, kitty.LEASES_MAX), f.transport.pendingCount());
    try std.testing.expectEqual(@as(usize, kitty.LEASES_MAX * 4), f.transport.pendingBytes());
    try std.testing.expect(f.transport.handleReply("\x1b_Gi=20;ENOENT:not found\x1b\\"));
    try std.testing.expectEqual(.unsupported, f.transport.file_state);
    try std.testing.expect(f.transport.retry_images);
    try std.testing.expectEqual(@as(u32, 0), f.transport.pendingCount());
    try f.expectNoFiles();
    try f.transmit(value, 100);
    try std.testing.expectEqual(.raw, f.transport.effective);
}

test "kitty file output failures do not leak resources" {
    var f: Fixture = undefined;
    try f.init();
    defer f.deinit();
    var failed: std.Io.Writer = .failing;
    try std.testing.expectError(error.WriteFailed, f.transport.startProbe(&failed, 7, f.directory[0..f.directory_len]));
    try std.testing.expectEqual(@as(u32, 0), f.transport.pendingCount());
    try f.expectNoFiles();
}

test "kitty file deadlines saturate without wrapping or extending the lease" {
    for ([_]u64{ std.math.maxInt(u64) - 1, std.math.maxInt(u64) }) |now_ns| {
        var f: Fixture = undefined;
        try f.init();
        defer f.deinit();
        try f.transport.startProbe(&f.output.writer, 7, f.directory[0..f.directory_len]);
        f.transport.expire(now_ns);
        if (now_ns < std.math.maxInt(u64)) {
            try std.testing.expectEqual(.probing, f.transport.file_state);
            f.transport.expire(std.math.maxInt(u64));
        }
        try std.testing.expectEqual(.timeout, f.transport.file_state);
        try std.testing.expectEqual(@as(u32, 0), f.transport.pendingCount());
        try f.expectNoFiles();
    }
}

test "kitty file failed unlinks stay accounted until expiry or teardown retries" {
    for ([_]bool{ false, true }) |teardown| {
        var f: Fixture = undefined;
        try f.init();
        defer f.deinit();
        var supplied: FileIo = .{};
        f.transport.io = supplied.io();
        try f.probe();
        supplied.fail_remove = true;
        f.transport.cancel(.cancelled);
        try std.testing.expectEqual(.io_error, f.transport.file_state);
        try std.testing.expectEqual(@as(u32, 1), f.transport.pendingCount());
        try std.testing.expectEqual(@as(usize, 3), f.transport.pendingBytes());
        supplied.fail_remove = false;
        if (teardown) f.transport.cancel(.cancelled) else f.transport.expire(kitty.TIMEOUT_NS);
        try std.testing.expectEqual(@as(u32, 2), supplied.removed);
        try std.testing.expectEqual(@as(u32, 0), f.transport.pendingCount());
        try std.testing.expectEqual(@as(usize, 0), f.transport.pendingBytes());
        try f.expectNoFiles();
    }
}

test "kitty file preparation failures fall back to raw without leases" {
    var transport: kitty.Transport = .{ .io = std.testing.io, .mode = .file, .file_state = .ready };
    defer transport.cancel(.cancelled);
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &.{ 1, 2, 3, 4 }, 1, 1, 4);
    defer value.deinit();
    try transport.transmit(std.testing.allocator, &output.writer, value, 19, false, "relative/path");
    try std.testing.expectEqual(.raw, transport.effective);
    try std.testing.expectEqual(.preparation, transport.fallback);
    try std.testing.expectEqual(.io_error, transport.file_state);
    try std.testing.expectEqual(@as(u32, 0), transport.pendingCount());
    try std.testing.expectEqual(@as(usize, 0), transport.pendingBytes());
    const payload = try @import("terminal-image_test.zig").decodeKittyChunks(output.written());
    defer std.testing.allocator.free(payload);
    try std.testing.expectEqualSlices(u8, &.{ 1, 2, 3, 4 }, payload);
}
