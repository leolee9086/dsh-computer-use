//! 不提窗的捕获、子 HWND 枚举与限定消息操作。原生身份每次重新核对。
use super::{matches_window, read_bitmap_pixels, window_title, FocusTarget, Region};
use serde::{Deserialize, Serialize};
use windows::Win32::Foundation::{BOOL, HWND, LPARAM, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    ClientToScreen, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject,
    GetWindowDC, ReleaseDC, SelectObject,
};
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::UI::Input::KeyboardAndMouse::IsWindowEnabled;
use windows::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, GetClassNameW, GetClientRect, GetForegroundWindow, GetParent, GetWindowRect,
    GetWindowThreadProcessId, IsChild, IsIconic, IsWindowVisible, PostMessageW,
    SendMessageTimeoutW, SetWindowPos, ShowWindow, PW_RENDERFULLCONTENT, SMTO_ABORTIFHUNG,
    SMTO_ERRORONEXIT, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SW_MAXIMIZE,
    SW_MINIMIZE, SW_RESTORE, WM_CLOSE, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP,
    WM_MOUSEHWHEEL, WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_RBUTTONDOWN, WM_RBUTTONUP,
};

pub fn checked_window(target: &FocusTarget) -> Result<HWND, String> {
    let value: isize = target.handle.parse().map_err(|_| "窗口句柄无效")?;
    let handle = HWND(value as *mut core::ffi::c_void);
    if !matches_window(handle, target) {
        return Err("目标窗口已不存在或身份不符（句柄/进程/标题）".into());
    }
    Ok(handle)
}
fn bounds(handle: HWND) -> Result<Region, String> {
    let mut rect = RECT::default();
    unsafe { GetWindowRect(handle, &mut rect) }.map_err(|e| format!("读取窗口边界失败: {e}"))?;
    let region = Region {
        x: rect.left,
        y: rect.top,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
    };
    if region.width < 1 || region.height < 1 {
        return Err("窗口边界为空".into());
    }
    Ok(region)
}
fn class_name(handle: HWND) -> String {
    let mut buffer = [0u16; 256];
    let size = unsafe { GetClassNameW(handle, &mut buffer) };
    String::from_utf16_lossy(&buffer[..size.max(0) as usize])
}
fn client_bounds(handle: HWND) -> Result<Region, String> {
    let mut rect = RECT::default();
    unsafe { GetClientRect(handle, &mut rect) }.map_err(|e| format!("GetClientRect: {e}"))?;
    let mut origin = POINT { x: 0, y: 0 };
    if !unsafe { ClientToScreen(handle, &mut origin) }.as_bool() {
        return Err("ClientToScreen 失败".into());
    }
    Ok(Region {
        x: origin.x,
        y: origin.y,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
    })
}

/// PrintWindow 按窗口完整边界渲染，不裁到屏幕、不恢复最小化、不改 Z-order。
/// 某些 GPU/保护窗口即便返回 true 也会画空白，调用者必须观察图像再决定是否可用。
pub fn capture(target: &FocusTarget) -> Result<(Region, Vec<u8>), String> {
    let handle = checked_window(target)?;
    if unsafe { IsIconic(handle) }.as_bool() {
        return Err("后台捕获不支持最小化窗口；请显式恢复窗口".into());
    }
    let region = bounds(handle)?;
    if i64::from(region.width) * i64::from(region.height) > 64_000_000 {
        return Err("窗口像素面积超过 64000000".into());
    }
    unsafe {
        let source = GetWindowDC(handle);
        if source.is_invalid() {
            return Err("GetWindowDC 失败".into());
        }
        let result = (|| {
            let dc = CreateCompatibleDC(source);
            if dc.is_invalid() {
                return Err("CreateCompatibleDC 失败".into());
            }
            let bitmap = CreateCompatibleBitmap(source, region.width, region.height);
            if bitmap.is_invalid() {
                let _ = DeleteDC(dc);
                return Err("CreateCompatibleBitmap 失败".into());
            }
            let previous = SelectObject(dc, bitmap);
            windows::Win32::Foundation::SetLastError(windows::Win32::Foundation::WIN32_ERROR(0));
            let rendered =
                PrintWindow(handle, dc, PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT)).as_bool();
            let render_error = windows::Win32::Foundation::GetLastError().0;
            // GetDIBits 要求待读位图不选入 DC。先恢复对象，再读取/删除。
            SelectObject(dc, previous);
            let pixels = if rendered {
                read_bitmap_pixels(dc, bitmap, region.width, region.height)
            } else {
                Err(format!(
                    "PrintWindow 未能渲染（Win32: {}，class: {}）；错误 5 请检查 helper 与目标的完整性级别；其它情况可能是应用不支持后台渲染",
                    render_error,
                    class_name(handle)
                ))
            };
            let _ = DeleteObject(bitmap);
            let _ = DeleteDC(dc);
            pixels
        })();
        let _ = ReleaseDC(handle, source);
        checked_window(target)?;
        Ok((region, result?))
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildWindow {
    pub id: String,
    pub parent_id: String,
    pub root_id: String,
    pub process_id: u32,
    pub class_name: String,
    pub title: String,
    pub visible: bool,
    pub enabled: bool,
    pub bounds: Region,
    pub client_bounds: Region,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChildRequest {
    pub window: FocusTarget,
    pub max_nodes: usize,
}
struct Enumeration {
    root: HWND,
    max: usize,
    records: Vec<ChildWindow>,
    error: Option<String>,
    truncated: bool,
}
unsafe extern "system" fn collect_child(handle: HWND, data: LPARAM) -> BOOL {
    let state = &mut *(data.0 as *mut Enumeration);
    if state.records.len() >= state.max {
        state.truncated = true;
        return BOOL(0);
    }
    let record = (|| {
        let mut pid = 0;
        if GetWindowThreadProcessId(handle, Some(&mut pid)) == 0 {
            return Err("子窗口进程读取失败".into());
        }
        let parent = GetParent(handle).map_err(|e| format!("GetParent: {e}"))?;
        Ok(ChildWindow {
            id: (handle.0 as isize).to_string(),
            parent_id: (parent.0 as isize).to_string(),
            root_id: (state.root.0 as isize).to_string(),
            process_id: pid,
            class_name: class_name(handle),
            title: window_title(handle),
            visible: IsWindowVisible(handle).as_bool(),
            enabled: IsWindowEnabled(handle).as_bool(),
            bounds: bounds(handle)?,
            client_bounds: client_bounds(handle)?,
        })
    })();
    match record {
        Ok(record) => state.records.push(record),
        Err(error) => {
            state.error = Some(error);
            return BOOL(0);
        }
    }
    BOOL(1)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildResponse {
    windows: Vec<ChildWindow>,
    truncated: bool,
}
pub fn children(request: &ChildRequest) -> Result<ChildResponse, String> {
    if !(1..=512).contains(&request.max_nodes) {
        return Err("maxNodes 必须 1..512".into());
    }
    let root = checked_window(&request.window)?;
    let mut state = Enumeration {
        root,
        max: request.max_nodes,
        records: vec![],
        error: None,
        truncated: false,
    };
    unsafe {
        let _ = EnumChildWindows(
            root,
            Some(collect_child),
            LPARAM(&mut state as *mut Enumeration as isize),
        );
    }
    if let Some(error) = state.error {
        return Err(error);
    }
    checked_window(&request.window)?;
    Ok(ChildResponse {
        windows: state.records,
        truncated: state.truncated,
    })
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageRequest {
    pub window: FocusTarget,
    pub child: ChildWindow,
    pub action: MessageAction,
}
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum MessageAction {
    Click {
        x: i32,
        y: i32,
        button: String,
    },
    #[serde(rename_all = "camelCase")]
    Scroll {
        x: i32,
        y: i32,
        delta_x: i32,
        delta_y: i32,
    },
}
fn checked_child(request: &MessageRequest) -> Result<HWND, String> {
    let root = checked_window(&request.window)?;
    let child = &request.child;
    let value: isize = child.id.parse().map_err(|_| "子窗口句柄无效")?;
    let handle = HWND(value as *mut core::ffi::c_void);
    let mut pid = 0;
    unsafe {
        if child.root_id != request.window.handle
            || !IsChild(root, handle).as_bool()
            || GetWindowThreadProcessId(handle, Some(&mut pid)) == 0
            || pid != child.process_id
            || pid != request.window.process_id as u32
            || class_name(handle) != child.class_name
            || window_title(handle) != child.title
            || (GetParent(handle).map_err(|e| e.to_string())?.0 as isize).to_string()
                != child.parent_id
        {
            return Err("子窗口身份已变更（父窗口/进程/类名/标题）".into());
        }
        if !IsWindowVisible(handle).as_bool() || !IsWindowEnabled(handle).as_bool() {
            return Err("子窗口不可见或已禁用".into());
        }
    }
    Ok(handle)
}
fn packed_point(x: i32, y: i32) -> Result<LPARAM, String> {
    if !(-32768..=32767).contains(&x) || !(-32768..=32767).contains(&y) {
        return Err("消息坐标超过 signed 16-bit 范围".into());
    }
    Ok(LPARAM(
        ((x as u16 as u32) | ((y as u16 as u32) << 16)) as isize,
    ))
}
fn message(handle: HWND, msg: u32, param: usize, location: LPARAM) -> Result<usize, String> {
    let mut result = 0usize;
    let sent = unsafe {
        SendMessageTimeoutW(
            handle,
            msg,
            WPARAM(param),
            location,
            SMTO_ABORTIFHUNG | SMTO_ERRORONEXIT,
            500,
            Some(&mut result),
        )
    };
    if sent.0 == 0 {
        return Err("窗口消息投递超时/拒绝，应用结果未知".into());
    }
    Ok(result)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageResponse {
    delivered: bool,
    application_result_verified: bool,
    foreground_changed: bool,
}
pub fn perform_message(request: &MessageRequest) -> Result<MessageResponse, String> {
    let handle = checked_child(request)?;
    let foreground_before = unsafe { GetForegroundWindow() };
    let client = client_bounds(handle)?;
    let (x, y) = match &request.action {
        MessageAction::Click { x, y, .. } | MessageAction::Scroll { x, y, .. } => (*x, *y),
    };
    if x < 0 || y < 0 || x >= client.width || y >= client.height {
        return Err("坐标超出子窗口客户区".into());
    }
    match &request.action {
        MessageAction::Click { button, .. } => {
            let (down, up, pressed) = match button.as_str() {
                "left" => (WM_LBUTTONDOWN, WM_LBUTTONUP, 1),
                "right" => (WM_RBUTTONDOWN, WM_RBUTTONUP, 2),
                "middle" => (WM_MBUTTONDOWN, WM_MBUTTONUP, 16),
                _ => return Err("不支持的鼠标键".into()),
            };
            let location = packed_point(x, y)?;
            message(handle, WM_MOUSEMOVE, 0, location)?;
            let pressed_result = message(handle, down, pressed, location);
            // 无论按下回执如何，尝试投递同窗口的释放，避免目标保留鼠标捕获。
            let released = message(handle, up, 0, location);
            pressed_result?;
            released?;
        }
        MessageAction::Scroll {
            delta_x, delta_y, ..
        } => {
            if !(-32768..=32767).contains(delta_x)
                || !(-32768..=32767).contains(delta_y)
                || (*delta_x == 0 && *delta_y == 0)
            {
                return Err("消息滚轮 delta 必须非零且在 signed 16-bit 范围".into());
            }
            let location = packed_point(client.x + x, client.y + y)?;
            if *delta_x != 0 {
                message(
                    handle,
                    WM_MOUSEHWHEEL,
                    (*delta_x as u16 as usize) << 16,
                    location,
                )?;
            }
            if *delta_y != 0 {
                message(
                    handle,
                    WM_MOUSEWHEEL,
                    (*delta_y as u16 as usize) << 16,
                    location,
                )?;
            }
        }
    }
    Ok(MessageResponse {
        delivered: true,
        application_result_verified: false,
        foreground_changed: unsafe { GetForegroundWindow() } != foreground_before,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManageRequest {
    pub window: FocusTarget,
    pub action: ManageAction,
}
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ManageAction {
    Move { x: i32, y: i32 },
    Resize { width: i32, height: i32 },
    Minimize,
    Maximize,
    Restore,
    Close,
}
pub fn manage(request: &ManageRequest) -> Result<serde_json::Value, String> {
    let handle = checked_window(&request.window)?;
    unsafe {
        match &request.action {
            ManageAction::Move { x, y } => SetWindowPos(
                handle,
                None,
                *x,
                *y,
                0,
                0,
                SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOSIZE,
            )
            .map_err(|e| e.to_string())?,
            ManageAction::Resize { width, height } => {
                if !(1..=32768).contains(width) || !(1..=32768).contains(height) {
                    return Err("窗口宽高必须 1..32768".into());
                }
                SetWindowPos(
                    handle,
                    None,
                    0,
                    0,
                    *width,
                    *height,
                    SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOMOVE,
                )
                .map_err(|e| e.to_string())?;
            }
            ManageAction::Minimize => {
                let _ = ShowWindow(handle, SW_MINIMIZE);
            }
            ManageAction::Maximize => {
                let _ = ShowWindow(handle, SW_MAXIMIZE);
            }
            ManageAction::Restore => {
                let _ = ShowWindow(handle, SW_RESTORE);
            }
            ManageAction::Close => {
                PostMessageW(handle, WM_CLOSE, WPARAM(0), LPARAM(0)).map_err(|e| e.to_string())?;
                return Ok(
                    serde_json::json!({ "posted": true, "applicationResultVerified": false }),
                );
            }
        }
    }
    checked_window(&request.window)?;
    Ok(
        serde_json::json!({ "ok": true, "bounds": bounds(handle)?, "minimized": unsafe { IsIconic(handle) }.as_bool() }),
    )
}
