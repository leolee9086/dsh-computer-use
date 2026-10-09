//! 可见顶层窗口的关系查询。owner 链与线程/进程相关性分别报告，不猜窗口归属。
//! 每次固定原窗口身份；目录是一次有界观测，不提供与随后动作之间的事务。
use super::window_control::checked_window;
use super::{process_name, window_title, FocusTarget, Region, WindowRecord};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use windows::Win32::Foundation::{BOOL, FALSE, HWND, LPARAM, RECT, TRUE};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetForegroundWindow, GetWindow, GetWindowRect,
    GetWindowThreadProcessId, IsIconic, IsWindowVisible, GW_OWNER,
};

fn owner_chain(handle: HWND) -> Result<Vec<String>, String> {
    let mut owners = Vec::new();
    let mut current = handle;
    // Win32 的零 owner 是正常的“无 owner”；不要将它猜成父窗口或前台窗口。
    while let Ok(owner) = unsafe { GetWindow(current, GW_OWNER) } {
        let id = (owner.0 as isize).to_string();
        if owner == handle || owners.contains(&id) || owners.len() >= 32 {
            return Err("window owner chain is cyclic or exceeds 32 links".into());
        }
        owners.push(id);
        current = owner;
    }
    Ok(owners)
}

pub fn observe(handle: HWND) -> Result<Option<WindowRecord>, String> {
    if !unsafe { IsWindowVisible(handle) }.as_bool() {
        return Ok(None);
    }
    let mut rect = RECT::default();
    unsafe { GetWindowRect(handle, &mut rect) }
        .map_err(|e| format!("window bounds unavailable: {e}"))?;
    // 无像素区域不属于此可见顶层范围；子 HWND 目录另行保留零面积窗口。
    if rect.right <= rect.left || rect.bottom <= rect.top {
        return Ok(None);
    }
    let mut process_id = 0;
    let thread_id = unsafe { GetWindowThreadProcessId(handle, Some(&mut process_id)) };
    if thread_id == 0 || process_id == 0 {
        return Err("window disappeared while reading its process/thread identity".into());
    }
    let mut class_buffer = [0u16; 512];
    let length = unsafe { GetClassNameW(handle, &mut class_buffer) };
    if length == 0 {
        return Err("window class unavailable during enumeration".into());
    }
    let class_name = String::from_utf16(&class_buffer[..length as usize])
        .map_err(|_| "window class contains invalid UTF-16")?;
    let owners = owner_chain(handle)?;
    Ok(Some(WindowRecord {
        id: (handle.0 as isize).to_string(),
        // 菜单与真正 WPF Popup 可以无标题；空字符串也是准确的观测值。
        title: window_title(handle),
        process_id,
        thread_id,
        class_name,
        owner_id: owners.first().cloned(),
        owner_chain: owners,
        application: process_name(process_id),
        focused: unsafe { GetForegroundWindow() } == handle,
        minimized: unsafe { IsIconic(handle) }.as_bool(),
        bounds: Region {
            x: rect.left,
            y: rect.top,
            width: rect.right - rect.left,
            height: rect.bottom - rect.top,
        },
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Relation {
    Owned,
    SameThread,
    SameProcess,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    window: FocusTarget,
    relation: Relation,
    title: Option<String>,
    class_name: Option<String>,
    max_nodes: usize,
    budget_ms: u64,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    source: &'static str,
    relation: &'static str,
    anchor_id: String,
    windows: Vec<WindowRecord>,
    visited: usize,
    coverage: &'static str,
    stop_reason: &'static str,
}
struct Scan<'a> {
    request: &'a Request,
    anchor_thread: u32,
    started: Instant,
    response: Response,
    error: Option<String>,
}
unsafe extern "system" fn collect(handle: HWND, data: LPARAM) -> BOOL {
    let scan = &mut *(data.0 as *mut Scan<'_>);
    if scan.started.elapsed() >= Duration::from_millis(scan.request.budget_ms) {
        scan.response.stop_reason = "time_budget";
        return FALSE;
    }
    if scan.response.visited >= scan.request.max_nodes {
        scan.response.stop_reason = "node_budget";
        return FALSE;
    }
    scan.response.visited += 1;
    let result = (|| {
        let record = match observe(handle)? {
            Some(record) => record,
            None => return Ok(()),
        };
        if record.id == scan.request.window.handle {
            return Ok(());
        }
        let related = match scan.request.relation {
            Relation::Owned => record.owner_chain.contains(&scan.request.window.handle),
            Relation::SameThread => record.thread_id == scan.anchor_thread,
            Relation::SameProcess => record.process_id == scan.request.window.process_id as u32,
        };
        if related
            && scan
                .request
                .title
                .as_ref()
                .map_or(true, |title| *title == record.title)
            && scan
                .request
                .class_name
                .as_ref()
                .map_or(true, |class| *class == record.class_name)
        {
            scan.response.windows.push(record);
        }
        Ok::<(), String>(())
    })();
    if let Err(error) = result {
        scan.error = Some(error);
        return FALSE;
    }
    TRUE
}

pub fn related(request: &Request) -> Result<Response, String> {
    if !(1..=4096).contains(&request.max_nodes)
        || !(1..=120000).contains(&request.budget_ms)
        || request.title.as_ref().is_some_and(|text| text.len() > 4096)
        || request
            .class_name
            .as_ref()
            .is_some_and(|text| text.is_empty() || text.len() > 1024)
    {
        return Err("invalid related-window filter or budget".into());
    }
    let anchor = checked_window(&request.window)?;
    let anchor_thread = unsafe { GetWindowThreadProcessId(anchor, None) };
    if anchor_thread == 0 {
        return Err("anchor window thread unavailable".into());
    }
    let relation = match request.relation {
        Relation::Owned => "owned",
        Relation::SameThread => "same_thread",
        Relation::SameProcess => "same_process",
    };
    let mut scan = Scan {
        request,
        anchor_thread,
        started: Instant::now(),
        error: None,
        response: Response {
            source: "win32_related_windows",
            relation,
            anchor_id: request.window.handle.clone(),
            windows: Vec::new(),
            visited: 0,
            coverage: "partial",
            stop_reason: "complete",
        },
    };
    let enumerated =
        unsafe { EnumWindows(Some(collect), LPARAM(&mut scan as *mut Scan<'_> as isize)) };
    if let Some(error) = scan.error {
        return Err(error);
    }
    // Callback 有界早停也令 EnumWindows 返回 false；只能按明确的停止原因区分。
    if scan.response.stop_reason == "complete" {
        enumerated.map_err(|e| format!("related-window enumeration failed: {e}"))?;
        scan.response.coverage = "complete";
    }
    checked_window(&request.window)?;
    // 不将枚举期间已关闭/换名的候选当成完整的缺失；原窗口改变同样直接失败。
    for record in &scan.response.windows {
        let focus = FocusTarget {
            handle: record.id.clone(),
            process_id: record.process_id as i32,
            title: record.title.clone(),
        };
        // 原 anchor 与候选新根的变化必须区分。候选替换只令本轮只读观测失效，
        // 调用方可在同一截止内重新枚举；原 anchor 不符仍是不可重定向的源错误。
        let handle =
            checked_window(&focus).map_err(|error| format!("related_window_changed: {error}"))?;
        if owner_chain(handle)? != record.owner_chain
            || unsafe { GetWindowThreadProcessId(handle, None) } != record.thread_id
        {
            return Err(
                "related_window_changed: candidate identity/owner changed during enumeration"
                    .into(),
            );
        }
    }
    if scan.started.elapsed() >= Duration::from_millis(request.budget_ms) {
        scan.response.coverage = "partial";
        scan.response.stop_reason = "time_budget";
    }
    Ok(scan.response)
}
