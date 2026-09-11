const c = @import("context_abi_c");
const abi = @import("context-abi.zig");
const handles = @import("context-handles.zig");
const clipboard = @import("clipboard/host.zig");
const ContextHandle = abi.ContextHandle;
const Handle = handles.Handle;

fn objects(context: ?*ContextHandle) ?*handles.Table {
    if (abi.sessionContextStatus(context) != c.OT_OK) return null;
    return &context.?.core.objects;
}

fn serviceHandle(table: *handles.Table) ?Handle {
    var cursor: usize = 0;
    return table.next(.clipboard_service, &cursor);
}

export fn clipboardServiceCreate(
    context: ?*ContextHandle,
    max_operations: u32,
    max_provider_transfers: u32,
    wayland_seat_pointer: ?[*]const u8,
    wayland_seat_length: u32,
) i32 {
    if (abi.sessionContextStatus(context) != c.OT_OK) return -1;
    _ = context.?.core.createClipboardService(
        max_operations,
        max_provider_transfers,
        wayland_seat_pointer,
        wayland_seat_length,
    ) catch return -1;
    return 0;
}

export fn clipboardServiceBeginShutdown(context: ?*ContextHandle) u8 {
    const table = objects(context) orelse return @intFromEnum(clipboard.ShutdownStatus.invalid_handle);
    const service = serviceHandle(table) orelse return @intFromEnum(clipboard.ShutdownStatus.invalid_handle);
    return @intFromEnum(clipboard.beginServiceShutdown(table, service));
}

export fn clipboardServicePollShutdown(context: ?*ContextHandle) u8 {
    const table = objects(context) orelse return @intFromEnum(clipboard.ShutdownStatus.invalid_handle);
    const service = serviceHandle(table) orelse return @intFromEnum(clipboard.ShutdownStatus.invalid_handle);
    return @intFromEnum(clipboard.pollServiceShutdown(table, service));
}

export fn clipboardServiceDestroy(context: ?*ContextHandle) u8 {
    const table = objects(context) orelse return @intFromEnum(clipboard.DestroyStatus.invalid_handle);
    const service = serviceHandle(table) orelse return @intFromEnum(clipboard.DestroyStatus.invalid_handle);
    return @intFromEnum(clipboard.destroyService(table, service));
}

export fn clipboardServiceDrain(context: ?*ContextHandle) u8 {
    const table = objects(context) orelse return 2;
    const service = serviceHandle(table) orelse return 2;
    return clipboard.drainService(table, service);
}

export fn clipboardReadOperationStart(
    context: ?*ContextHandle,
    request_pointer: ?[*]const u8,
    request_length: u32,
    selection: u8,
    max_bytes: u32,
    max_image_pixels: u32,
    max_conversion_bytes: u32,
    timeout_ms: u32,
    out_operation_handle: ?*Handle,
) u8 {
    const table = objects(context) orelse return @intFromEnum(clipboard.StartStatus.invalid_service);
    const service = serviceHandle(table) orelse return @intFromEnum(clipboard.StartStatus.invalid_service);
    return @intFromEnum(clipboard.startReadOperation(
        table,
        service,
        request_pointer,
        request_length,
        selection,
        max_bytes,
        max_image_pixels,
        max_conversion_bytes,
        timeout_ms,
        out_operation_handle,
    ));
}

export fn clipboardWriteOperationStart(
    context: ?*ContextHandle,
    text_pointer: ?[*]const u8,
    text_length: u32,
    selection: u8,
    timeout_ms: u32,
    out_operation_handle: ?*Handle,
) u8 {
    const table = objects(context) orelse return @intFromEnum(clipboard.StartStatus.invalid_service);
    const service = serviceHandle(table) orelse return @intFromEnum(clipboard.StartStatus.invalid_service);
    return @intFromEnum(clipboard.startWriteOperation(
        table,
        service,
        text_pointer,
        text_length,
        selection,
        timeout_ms,
        out_operation_handle,
    ));
}

export fn clipboardClearOperationStart(
    context: ?*ContextHandle,
    selection: u8,
    timeout_ms: u32,
    out_operation_handle: ?*Handle,
) u8 {
    const table = objects(context) orelse return @intFromEnum(clipboard.StartStatus.invalid_service);
    const service = serviceHandle(table) orelse return @intFromEnum(clipboard.StartStatus.invalid_service);
    return @intFromEnum(clipboard.startClearOperation(table, service, selection, timeout_ms, out_operation_handle));
}

export fn clipboardOperationPoll(context: ?*ContextHandle, operation: *const Handle) u8 {
    const table = objects(context) orelse return @intFromEnum(clipboard.OperationStatus.invalid_handle);
    return @intFromEnum(clipboard.pollOperation(table, operation.*));
}

export fn clipboardOperationCancel(context: ?*ContextHandle, operation: *const Handle) u8 {
    const table = objects(context) orelse return @intFromEnum(clipboard.CancelStatus.invalid_handle);
    return @intFromEnum(clipboard.cancelOperation(table, operation.*));
}

export fn clipboardOperationResultMimeLength(context: ?*ContextHandle, operation: *const Handle, out_length: ?*u32) u8 {
    const table = objects(context) orelse return @intFromEnum(clipboard.CopyStatus.invalid_handle);
    return @intFromEnum(clipboard.resultMimeLength(table, operation.*, out_length));
}

export fn clipboardOperationResultMimeCopy(context: ?*ContextHandle, operation: *const Handle, out_pointer: ?[*]u8, capacity: u32) u8 {
    const table = objects(context) orelse return @intFromEnum(clipboard.CopyStatus.invalid_handle);
    return @intFromEnum(clipboard.resultMimeCopy(table, operation.*, out_pointer, capacity));
}

export fn clipboardOperationResultDataLength(context: ?*ContextHandle, operation: *const Handle, out_length: ?*u32) u8 {
    const table = objects(context) orelse return @intFromEnum(clipboard.CopyStatus.invalid_handle);
    return @intFromEnum(clipboard.resultDataLength(table, operation.*, out_length));
}

export fn clipboardOperationResultDataCopy(context: ?*ContextHandle, operation: *const Handle, out_pointer: ?[*]u8, capacity: u32) u8 {
    const table = objects(context) orelse return @intFromEnum(clipboard.CopyStatus.invalid_handle);
    return @intFromEnum(clipboard.resultDataCopy(table, operation.*, out_pointer, capacity));
}

export fn clipboardOperationResultErrorCode(context: ?*ContextHandle, operation: *const Handle, out_error_code: ?*u32) u8 {
    const table = objects(context) orelse return @intFromEnum(clipboard.CopyStatus.invalid_handle);
    return @intFromEnum(clipboard.resultErrorCode(table, operation.*, out_error_code));
}

export fn clipboardOperationResultDiagnosticLength(context: ?*ContextHandle, operation: *const Handle, out_length: ?*u32) u8 {
    const table = objects(context) orelse return @intFromEnum(clipboard.CopyStatus.invalid_handle);
    return @intFromEnum(clipboard.resultDiagnosticLength(table, operation.*, out_length));
}

export fn clipboardOperationResultDiagnosticCopy(context: ?*ContextHandle, operation: *const Handle, out_pointer: ?[*]u8, capacity: u32) u8 {
    const table = objects(context) orelse return @intFromEnum(clipboard.CopyStatus.invalid_handle);
    return @intFromEnum(clipboard.resultDiagnosticCopy(table, operation.*, out_pointer, capacity));
}

export fn clipboardOperationDestroy(context: ?*ContextHandle, operation: *const Handle) u8 {
    const table = objects(context) orelse return @intFromEnum(clipboard.DestroyStatus.invalid_handle);
    return @intFromEnum(clipboard.destroyOperation(table, operation.*));
}
