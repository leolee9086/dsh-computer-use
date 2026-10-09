//! 标准 SysListView32 的有界内容读取；不聚焦、不选择、不滚动。
//!
//! WM_USER 以上的消息不会由系统封送指针。SendMessageTimeout 超时后目标
//! 仍可能使用远端 LVITEM，因此文本走完成回调，绝不把“超时返回”当作释放许可。
//! ReplyMessage 可能在处理函数结束前触发回调；回调后仍验证长度、首个 NUL
//! 和 UTF-16。一个具名事件先复制进目标进程，再分配固定 8192 字节。
//! helper 被终止、回调超时或文本校验失败时，目标事件阻止后续 helper 再分配；
//! 事件和最多一块缓冲由目标进程退出回收。正常完成先释放缓冲再关闭目标句柄。
//! 定制控件必须遵守文本回复协议；恶意控件先写正确文本再继续使用指针的行为
//! 无法由这些校验证明安全，这条路径只适用于遵守协议的标准 ListView。
//! 依据：https://devblogs.microsoft.com/oldnewthing/20110915-00/?p=9643
use super::window_control::{checked_child_identity, ChildWindow};
use super::FocusTarget;
use serde::{Deserialize, Serialize};
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::time::{Duration, Instant};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{
    CloseHandle, DuplicateHandle, GetLastError, SetLastError, BOOL, DUPLICATE_CLOSE_SOURCE,
    DUPLICATE_SAME_ACCESS, ERROR_ALREADY_EXISTS, FILETIME, HANDLE, HWND, LPARAM, LRESULT,
    WIN32_ERROR, WPARAM,
};
use windows::Win32::System::Diagnostics::Debug::{ReadProcessMemory, WriteProcessMemory};
use windows::Win32::System::Memory::{
    VirtualAllocEx, VirtualFreeEx, MEM_COMMIT, MEM_RELEASE, MEM_RESERVE, PAGE_READWRITE,
};
use windows::Win32::System::Threading::{
    CreateEventW, GetCurrentProcess, GetProcessTimes, IsWow64Process, OpenProcess,
    PROCESS_DUP_HANDLE, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_OPERATION, PROCESS_VM_READ,
    PROCESS_VM_WRITE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetClassNameW, GetWindowLongW, GetWindowThreadProcessId, IsChild, PeekMessageW,
    SendMessageCallbackW, SendMessageTimeoutW, GWL_STYLE, MSG, PM_NOREMOVE, SMTO_ABORTIFHUNG,
    SMTO_BLOCK, SMTO_ERRORONEXIT,
};

const REMOTE_BYTES: usize = 8192;
const TEXT_OFFSET: usize = 128;
const LVM_GETITEMCOUNT: u32 = 0x1004;
const LVM_GETNEXTITEM: u32 = 0x100c;
const LVM_GETHEADER: u32 = 0x101f;
const LVM_GETITEMSTATE: u32 = 0x102c;
const LVM_GETSELECTEDCOUNT: u32 = 0x1032;
const LVM_GETITEMTEXTW: u32 = 0x1073;
const HDM_GETITEMCOUNT: u32 = 0x1200;
const LVS_OWNERDATA: i32 = 0x1000;
static CALLBACK_DONE: AtomicBool = AtomicBool::new(false);
static CALLBACK_RESULT: AtomicIsize = AtomicIsize::new(0);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub window: FocusTarget,
    pub child: ChildWindow,
    pub columns: Vec<u32>,
    pub start_row: u32,
    pub max_rows: u32,
    pub max_cells: u32,
    pub max_chars: usize,
    pub max_cell_chars: usize,
    pub budget_ms: u64,
    pub message_timeout_ms: u32,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cell {
    column: u32,
    text: String,
    complete: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    index: u32,
    selected: bool,
    focused: bool,
    cells: Vec<Cell>,
    complete: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    source: &'static str,
    class_name: String,
    target_bits: Option<u32>,
    row_count: Option<u32>,
    column_count: Option<u32>,
    selected_count: Option<u32>,
    focused_row: Option<u32>,
    columns: Vec<u32>,
    start_row: u32,
    next_row: u32,
    rows: Vec<Row>,
    cells_read: u32,
    chars_read: usize,
    coverage: &'static str,
    stop_reason: &'static str,
    error: Option<String>,
    failed_row: Option<u32>,
    failed_column: Option<u32>,
    source_count_changed: bool,
    remote_buffer_quarantined: bool,
    messages: u32,
    elapsed_ms: u128,
}
struct OwnedHandle(HANDLE);
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

fn process_identity(process: HANDLE) -> Result<u64, String> {
    let (mut created, mut exited, mut kernel, mut user) = (
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
    );
    unsafe { GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user) }
        .map_err(|e| format!("GetProcessTimes: {e}"))?;
    Ok((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
}
fn target_bits(process: HANDLE) -> Result<u32, String> {
    // 发布 helper 是 64 位；显式拒绝不能容纳 64 位远端指针的构建。
    if !cfg!(target_pointer_width = "64") {
        return Err("ListView reader requires a 64-bit helper".into());
    }
    let mut wow64 = BOOL(0);
    unsafe { IsWow64Process(process, &mut wow64) }.map_err(|e| format!("IsWow64Process: {e}"))?;
    Ok(if wow64.as_bool() { 32 } else { 64 })
}
struct RemoteBuffer {
    process: OwnedHandle,
    event: OwnedHandle,
    target_event: HANDLE,
    address: *mut c_void,
    pending: bool,
    release_attempted: bool,
    bits: u32,
}
impl RemoteBuffer {
    fn new(pid: u32) -> Result<Self, String> {
        let process = OwnedHandle(
            unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION
                        | PROCESS_DUP_HANDLE
                        | PROCESS_VM_OPERATION
                        | PROCESS_VM_READ
                        | PROCESS_VM_WRITE,
                    false,
                    pid,
                )
            }
            .map_err(|e| format!("OpenProcess for standard control read: {e}"))?,
        );
        let created = process_identity(process.0)?;
        let bits = target_bits(process.0)?;
        // 名称故意不包含包版本/helper 路径/session；重启和不同 helper 也共享上限。
        let name: Vec<u16> = format!("Local\\DSHComputerUse_ListViewBuffer_{pid}_{created:016x}")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        unsafe {
            SetLastError(WIN32_ERROR(0));
        }
        let event = OwnedHandle(
            unsafe { CreateEventW(None, true, false, PCWSTR(name.as_ptr())) }
                .map_err(|e| format!("CreateEventW for remote-buffer guard: {e}"))?,
        );
        if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
            return Err("remote_buffer_busy_or_quarantined: this process already has an active or unconfirmed ListView read; do not retry allocation until the target process exits".into());
        }
        let mut remote = Self {
            process,
            event,
            target_event: HANDLE::default(),
            address: std::ptr::null_mut(),
            pending: false,
            release_attempted: false,
            bits,
        };
        // 必须先将标记交给目标。此后即便在任意指令间被 kill，也不能出现无标记的分配。
        unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                remote.event.0,
                remote.process.0,
                &mut remote.target_event,
                0,
                false,
                DUPLICATE_SAME_ACCESS,
            )
        }
        .map_err(|e| format!("DuplicateHandle guard into target: {e}"))?;
        remote.address = unsafe {
            VirtualAllocEx(
                remote.process.0,
                None,
                REMOTE_BYTES,
                MEM_COMMIT | MEM_RESERVE,
                PAGE_READWRITE,
            )
        };
        if remote.address.is_null() {
            return Err(format!("VirtualAllocEx: {}", unsafe { GetLastError().0 }));
        }
        if bits == 32 && remote.address as usize + REMOTE_BYTES > u32::MAX as usize {
            return Err("32-bit target allocation exceeds pointer range".into());
        }
        Ok(remote)
    }
    fn write(&self, data: &[u8]) -> Result<(), String> {
        if self.pending {
            return Err("cannot overwrite a pending remote buffer".into());
        }
        if data.len() > REMOTE_BYTES {
            return Err("remote buffer write exceeds fixed bound".into());
        }
        let mut count = 0;
        unsafe {
            WriteProcessMemory(
                self.process.0,
                self.address,
                data.as_ptr().cast(),
                data.len(),
                Some(&mut count),
            )
        }
        .map_err(|e| format!("WriteProcessMemory: {e}"))?;
        if count != data.len() {
            return Err("short WriteProcessMemory".into());
        }
        Ok(())
    }
    fn text(&self, units: usize) -> Result<Vec<u16>, String> {
        let mut data = vec![0u16; units];
        let mut count = 0;
        unsafe {
            ReadProcessMemory(
                self.process.0,
                (self.address as usize + TEXT_OFFSET) as *const c_void,
                data.as_mut_ptr().cast(),
                units * 2,
                Some(&mut count),
            )
        }
        .map_err(|e| format!("ReadProcessMemory: {e}"))?;
        if count != units * 2 {
            return Err("short ReadProcessMemory".into());
        }
        Ok(data)
    }
    fn release(&mut self) -> Result<(), String> {
        if self.pending || self.release_attempted {
            return Ok(());
        } // 未确认完成，目标退出才可回收；失败清理也绝不在 Drop 中重试。
        self.release_attempted = true;
        if !self.address.is_null() {
            unsafe { VirtualFreeEx(self.process.0, self.address, 0, MEM_RELEASE) }
                .map_err(|e| format!("VirtualFreeEx: {e}"))?;
            self.address = std::ptr::null_mut();
        }
        if !self.target_event.is_invalid() {
            // DUPLICATE_CLOSE_SOURCE 即使复制失败也关闭源句柄。提前清除本地记录，
            // 防止错误后的 Drop 关闭已经被目标复用的相同数值。
            let target_event = self.target_event;
            self.target_event = HANDLE::default();
            let mut copied = HANDLE::default();
            unsafe {
                DuplicateHandle(
                    self.process.0,
                    target_event,
                    GetCurrentProcess(),
                    &mut copied,
                    0,
                    false,
                    DUPLICATE_CLOSE_SOURCE | DUPLICATE_SAME_ACCESS,
                )
            }
            .map_err(|e| format!("close target buffer guard: {e}"))?;
            drop(OwnedHandle(copied));
        }
        Ok(())
    }
}
impl Drop for RemoteBuffer {
    fn drop(&mut self) {
        let _ = self.release();
    }
}

// 用 byte 布局写出两种 LVITEMW，不能把本 helper 的指针宽度当作目标宽度。
fn item_bytes(
    bits: u32,
    row: u32,
    column: u32,
    pointer: usize,
    capacity: usize,
) -> Result<Vec<u8>, String> {
    if ![32, 64].contains(&bits) || capacity < 2 || capacity > 4001 {
        return Err("invalid remote LVITEM layout/capacity".into());
    }
    let mut bytes = vec![0u8; TEXT_OFFSET + capacity * 2];
    // 未写入的文本不能看起来像一个已完成的空串；正确处理必须写出终止符。
    bytes[TEXT_OFFSET..].fill(0xff);
    bytes[0..4].copy_from_slice(&1u32.to_le_bytes()); // LVIF_TEXT
    bytes[4..8].copy_from_slice(&row.to_le_bytes());
    bytes[8..12].copy_from_slice(&column.to_le_bytes());
    if bits == 32 {
        let pointer =
            u32::try_from(pointer).map_err(|_| "remote text pointer does not fit 32 bits")?;
        bytes[20..24].copy_from_slice(&pointer.to_le_bytes());
        bytes[24..28].copy_from_slice(&(capacity as u32).to_le_bytes());
    } else {
        bytes[24..32].copy_from_slice(&(pointer as u64).to_le_bytes());
        bytes[32..36].copy_from_slice(&(capacity as u32).to_le_bytes());
    }
    Ok(bytes)
}
unsafe extern "system" fn completed(_hwnd: HWND, _msg: u32, _data: usize, result: LRESULT) {
    CALLBACK_RESULT.store(result.0, Ordering::Relaxed);
    CALLBACK_DONE.store(true, Ordering::Release);
}
struct Reader {
    deadline: Instant,
    message_ms: u32,
    messages: u32,
}
impl Reader {
    fn remaining(&self) -> Result<u32, String> {
        let duration = self
            .deadline
            .checked_duration_since(Instant::now())
            .ok_or("total_budget_exhausted")?;
        if duration.is_zero() {
            return Err("total_budget_exhausted".into());
        }
        Ok(duration.as_millis().max(1).min(u128::from(self.message_ms)) as u32)
    }
    fn scalar(
        &mut self,
        hwnd: HWND,
        msg: u32,
        wparam: usize,
        lparam: isize,
    ) -> Result<usize, String> {
        let remaining = self.remaining()?;
        let mut result = 0;
        self.messages += 1;
        unsafe {
            SetLastError(WIN32_ERROR(0));
        }
        let sent = unsafe {
            SendMessageTimeoutW(
                hwnd,
                msg,
                WPARAM(wparam),
                LPARAM(lparam),
                SMTO_BLOCK | SMTO_ABORTIFHUNG | SMTO_ERRORONEXIT,
                remaining,
                Some(&mut result),
            )
        };
        if sent.0 == 0 {
            return Err(format!(
                "source_message_timeout_or_denied: msg={msg:#x}, win32={}",
                unsafe { GetLastError().0 }
            ));
        }
        Ok(result)
    }
    fn cell(
        &mut self,
        hwnd: HWND,
        buffer: &mut RemoteBuffer,
        row: u32,
        column: u32,
        chars: usize,
    ) -> Result<Cell, String> {
        let remaining = self.remaining()?;
        let capacity = chars + 1;
        let bytes = item_bytes(
            buffer.bits,
            row,
            column,
            buffer.address as usize + TEXT_OFFSET,
            capacity,
        )?;
        buffer.write(&bytes)?;
        CALLBACK_DONE.store(false, Ordering::Release);
        let message_deadline =
            (Instant::now() + Duration::from_millis(u64::from(remaining))).min(self.deadline);
        buffer.pending = true; // 在发送前置位；任何不确定失败都保留隔离标记。
        self.messages += 1;
        unsafe {
            SendMessageCallbackW(
                hwnd,
                LVM_GETITEMTEXTW,
                WPARAM(row as usize),
                LPARAM(buffer.address as isize),
                Some(completed),
                0,
            )
        }
        .map_err(|e| format!("SendMessageCallbackW: {e}"))?;
        loop {
            // 回调由发送线程在消息检索时调用；static 状态不会在超时后成为悬空指针。
            let mut message = MSG::default();
            unsafe {
                let _ = PeekMessageW(&mut message, None, 0, 0, PM_NOREMOVE);
            }
            if CALLBACK_DONE.load(Ordering::Acquire) {
                // ReplyMessage 可在实际文本写入前触发回调。校验完成前保持 pending，
                // 任何错误都不能允许远端释放或下一次消息覆盖这块缓冲。
                break;
            }
            if Instant::now() >= message_deadline {
                return Err("source_callback_timeout: remote buffer retained and process quarantined until target exit".into());
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        let length = usize::try_from(CALLBACK_RESULT.load(Ordering::Relaxed))
            .map_err(|_| "negative ListView text length")?;
        if length >= capacity {
            return Err("ListView returned an invalid text length".into());
        }
        let text = buffer.text(capacity)?;
        if text[length] != 0 || text[..length].contains(&0) {
            return Err("source_text_reply_incomplete: ListView reply length does not match its written text; buffer quarantined".into());
        }
        // 容量截断可能恰好留下一半代理对。只在已用满容量的最后一个高代理
        // 处缩短前缀；其他畸形 UTF-16 仍然报来源错误，绝不替换成猜测字符。
        let prefix_length =
            if length == chars && length > 0 && (0xd800..=0xdbff).contains(&text[length - 1]) {
                length - 1
            } else {
                length
            };
        let value = String::from_utf16(&text[..prefix_length])
            .map_err(|_| "ListView returned malformed UTF-16")?;
        // 合同成立才允许复用；定制控件若提前回复却继续使用指针，不遵守此协议。
        buffer.pending = false;
        // 达到容量边界无法证明全文未截断，保守标记；不自动增大缓冲重读。
        Ok(Cell {
            column,
            text: value,
            complete: length < chars,
        })
    }
}
fn count(value: usize, label: &str) -> Result<u32, String> {
    if value > i32::MAX as usize {
        return Err(format!("invalid {label}"));
    }
    Ok(value as u32)
}
fn is_listview(class: &str) -> bool {
    class == "SysListView32" || class.starts_with("WindowsForms10.SysListView32.")
}
fn validate(request: &Request) -> Result<(), String> {
    if request.columns.is_empty()
        || request.columns.len() > 32
        || request.columns.iter().any(|c| *c > 255)
        || request
            .columns
            .iter()
            .enumerate()
            .any(|(i, c)| request.columns[..i].contains(c))
    {
        return Err("columns must contain 1..32 unique zero-based indices in 0..255".into());
    }
    if request.start_row > i32::MAX as u32
        || !(1..=512).contains(&request.max_rows)
        || !(1..=4096).contains(&request.max_cells)
        || !(1..=262144).contains(&request.max_chars)
        || !(1..=4000).contains(&request.max_cell_chars)
        || !(1..=120000).contains(&request.budget_ms)
        || !(1..=1000).contains(&request.message_timeout_ms)
    {
        return Err("invalid ListView row/cell/character/deadline budget".into());
    }
    Ok(())
}
pub fn read(request: &Request) -> Result<Response, String> {
    validate(request)?;
    let started = Instant::now();
    let hwnd = checked_child_identity(&request.window, &request.child)?;
    if !is_listview(&request.child.class_name) {
        return Err(format!(
            "unsupported_standard_control: {}",
            request.child.class_name
        ));
    }
    if unsafe { GetWindowLongW(hwnd, GWL_STYLE) } & LVS_OWNERDATA != 0 {
        return Err("unsupported_owner_data: LVM_GETITEMTEXTW does not support LVS_OWNERDATA; use UIA/ItemContainer instead".into());
    }
    let mut reader = Reader {
        deadline: started + Duration::from_millis(request.budget_ms),
        message_ms: request.message_timeout_ms,
        messages: 0,
    };
    let mut response = Response {
        source: "win32_listview_messages",
        class_name: request.child.class_name.clone(),
        target_bits: None,
        row_count: None,
        column_count: None,
        selected_count: None,
        focused_row: None,
        columns: request.columns.clone(),
        start_row: request.start_row,
        next_row: request.start_row,
        rows: vec![],
        cells_read: 0,
        chars_read: 0,
        coverage: "partial",
        stop_reason: "source_error",
        error: None,
        failed_row: None,
        failed_column: None,
        source_count_changed: false,
        remote_buffer_quarantined: false,
        messages: 0,
        elapsed_ms: 0,
    };
    let mut buffer: Option<RemoteBuffer> = None;
    let result = (|| -> Result<(), String> {
        let rows = count(reader.scalar(hwnd, LVM_GETITEMCOUNT, 0, 0)?, "row count")?;
        response.row_count = Some(rows);
        let header = HWND(reader.scalar(hwnd, LVM_GETHEADER, 0, 0)? as *mut c_void);
        if !header.is_invalid() {
            let mut pid = 0;
            let mut class = [0u16; 256];
            let length = unsafe { GetClassNameW(header, &mut class) };
            if unsafe { GetWindowThreadProcessId(header, Some(&mut pid)) } == 0
                || pid != request.child.process_id
                || !unsafe { IsChild(hwnd, header) }.as_bool()
                || String::from_utf16_lossy(&class[..length.max(0) as usize]) != "SysHeader32"
            {
                return Err("invalid ListView header identity".into());
            }
            response.column_count = Some(count(
                reader.scalar(header, HDM_GETITEMCOUNT, 0, 0)?,
                "column count",
            )?);
        }
        if request
            .columns
            .iter()
            .any(|c| response.column_count.map_or(*c != 0, |n| *c >= n))
        {
            return Err(
                "requested column does not exist or cannot be established without a header".into(),
            );
        }
        let selected = count(
            reader.scalar(hwnd, LVM_GETSELECTEDCOUNT, 0, 0)?,
            "selected count",
        )?;
        if selected > rows {
            return Err("selection count exceeds row count".into());
        }
        response.selected_count = Some(selected);
        let focused = reader.scalar(hwnd, LVM_GETNEXTITEM, usize::MAX, 1)? as isize;
        if focused < -1 || focused >= rows as isize {
            return Err("invalid focused row".into());
        }
        if focused >= 0 {
            response.focused_row = Some(focused as u32);
        }
        if request.start_row > rows {
            return Err("startRow exceeds row count".into());
        }
        let end = rows.min(request.start_row.saturating_add(request.max_rows));
        for index in request.start_row..end {
            if response.cells_read >= request.max_cells {
                response.stop_reason = "cell_limit";
                return Ok(());
            }
            if response.chars_read >= request.max_chars {
                response.stop_reason = "character_limit";
                return Ok(());
            }
            response.failed_row = Some(index);
            let state = reader.scalar(hwnd, LVM_GETITEMSTATE, index as usize, 3)?;
            response.rows.push(Row {
                index,
                selected: state & 2 != 0,
                focused: state & 1 != 0,
                cells: vec![],
                complete: false,
            });
            for column in &request.columns {
                if response.cells_read >= request.max_cells {
                    response.stop_reason = "cell_limit";
                    return Ok(());
                }
                let chars = request
                    .max_cell_chars
                    .min(request.max_chars - response.chars_read);
                if chars == 0 {
                    response.stop_reason = "character_limit";
                    return Ok(());
                }
                response.failed_column = Some(*column);
                if buffer.is_none() {
                    buffer = Some(RemoteBuffer::new(request.child.process_id)?);
                }
                let remote = buffer.as_mut().ok_or("remote buffer missing")?;
                response.target_bits = Some(remote.bits);
                let cell = reader.cell(hwnd, remote, index, *column, chars)?;
                response.cells_read += 1;
                response.chars_read += cell.text.encode_utf16().count();
                let complete = cell.complete;
                response
                    .rows
                    .last_mut()
                    .ok_or("row missing")?
                    .cells
                    .push(cell);
                if !complete {
                    response.stop_reason = if chars < request.max_cell_chars {
                        "character_limit"
                    } else {
                        "cell_text_limit"
                    };
                    return Ok(());
                }
                response.failed_column = None;
            }
            response.rows.last_mut().ok_or("row missing")?.complete = true;
            response.next_row = index + 1;
            response.failed_row = None;
        }
        let after = count(
            reader.scalar(hwnd, LVM_GETITEMCOUNT, 0, 0)?,
            "final row count",
        )?;
        if after != rows {
            response.source_count_changed = true;
            response.stop_reason = "source_count_changed";
        } else if end < rows {
            response.stop_reason = "row_limit";
        } else if request.start_row != 0 {
            response.stop_reason = "row_start";
        } else {
            response.coverage = "complete";
            response.stop_reason = "complete";
        }
        Ok(())
    })();
    if let Err(error) = result {
        response.error = Some(error);
        response.stop_reason = "source_error";
        response.coverage = "partial";
    }
    if let Some(remote) = buffer.as_mut() {
        response.remote_buffer_quarantined = remote.pending;
        if let Err(error) = remote.release() {
            response.remote_buffer_quarantined = !remote.address.is_null();
            response.coverage = "partial";
            response.stop_reason = "source_error";
            response.error = Some(match response.error {
                Some(prior) => format!("{prior}; {error}"),
                None => error,
            });
        }
    }
    if let Err(error) = checked_child_identity(&request.window, &request.child) {
        response.coverage = "partial";
        response.stop_reason = "source_error";
        response.error = Some(match response.error {
            Some(prior) => format!("{prior}; {error}"),
            None => error,
        });
    }
    response.messages = reader.messages;
    response.elapsed_ms = started.elapsed().as_millis();
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn layouts_use_target_pointer_width() {
        let x86 = item_bytes(32, 17, 2, 0x12345678, 41).unwrap();
        let x64 = item_bytes(64, 17, 2, 0x1234567812345678, 41).unwrap();
        assert_eq!(&x86[20..24], &0x12345678u32.to_le_bytes());
        assert_eq!(&x86[24..28], &41u32.to_le_bytes());
        assert_eq!(&x64[24..32], &0x1234567812345678u64.to_le_bytes());
        assert_eq!(&x64[32..36], &41u32.to_le_bytes());
        assert_eq!(&x64[8..12], &2u32.to_le_bytes());
        assert!(x86[TEXT_OFFSET..].iter().all(|b| *b == 0xff));
    }
    #[test]
    fn pointer_and_class_boundaries_are_explicit() {
        assert!(item_bytes(32, 0, 0, u32::MAX as usize + 1, 41).is_err());
        assert!(item_bytes(64, 0, 0, 0, 4002).is_err());
        assert!(item_bytes(64, 0, 0, 0, 4001).unwrap().len() <= REMOTE_BYTES);
        assert!(is_listview("SysListView32"));
        assert!(is_listview("WindowsForms10.SysListView32.app.0.123"));
        assert!(!is_listview("WindowsForms10.Panel.app.0.123"));
        assert!(!is_listview("FakeSysListView32"));
    }
}
