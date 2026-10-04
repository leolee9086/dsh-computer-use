//! 一次调用内完成的有界输入序列。所有参数先验证，错误时停止，释放本次持有的输入。
//! 不跨进程保存按下状态，避免下一次工具失败让整个桌面卡在 Ctrl/拖拽状态。
use super::{mouse_flags, pointer_move, sleep_ms, type_text, virtual_key};
use serde::Deserialize;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE,
    KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, MAPVK_VK_TO_VSC_EX,
    MOUSEEVENTF_HWHEEL, MOUSEEVENTF_WHEEL, MOUSEINPUT, MOUSE_EVENT_FLAGS,
};

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Step {
    Move {
        x: i32,
        y: i32,
    },
    MouseDown {
        button: String,
    },
    MouseUp {
        button: String,
    },
    KeyDown {
        key: i32,
    },
    KeyUp {
        key: i32,
    },
    Wait {
        ms: i64,
    },
    Type {
        text: String,
    },
    #[serde(rename_all = "camelCase")]
    Scroll {
        x: i32,
        y: i32,
        delta_x: i32,
        delta_y: i32,
    },
    #[serde(rename_all = "camelCase")]
    Key {
        key: i32,
        modifiers: Vec<i32>,
        repeat: i32,
        hold_ms: i64,
    },
}

// MapVirtualKey 的高字节标示 E0/E1 前缀。Insert/Delete/方向键/右 Ctrl/Alt 需 EXTENDEDKEY。
fn send_key(code: i32, up: bool) -> Result<(), String> {
    let vk = virtual_key(code)?;
    let scan = unsafe { MapVirtualKeyW(code as u32, MAPVK_VK_TO_VSC_EX) };
    let mut flags = if up { KEYEVENTF_KEYUP.0 } else { 0 };
    if scan & 0xff00 != 0 {
        flags |= KEYEVENTF_EXTENDEDKEY.0;
    }
    let event = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: (scan & 0xff) as u16,
                dwFlags: KEYBD_EVENT_FLAGS(flags),
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    send(event)
}
fn send_mouse(flags: MOUSE_EVENT_FLAGS, data: i32) -> Result<(), String> {
    send(INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: 0,
                dy: 0,
                mouseData: data as u32,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    })
}
fn send(event: INPUT) -> Result<(), String> {
    if unsafe { SendInput(&[event], std::mem::size_of::<INPUT>() as i32) } != 1 {
        return Err("SendInput 未能投递输入（可能受完整性级别/UIPI 限制）".into());
    }
    Ok(())
}
fn mouse_code(button: &str) -> i32 {
    match button {
        "left" => 1,
        "right" => 2,
        "middle" => 4,
        _ => 0,
    }
}

#[derive(Default)]
struct Held {
    keys: Vec<i32>,
    buttons: Vec<String>,
}
impl Held {
    fn key_down(&mut self, key: i32) -> Result<(), String> {
        if self.keys.contains(&key) {
            return Err(format!("键 {key} 已由本序列按下"));
        }
        if unsafe { GetAsyncKeyState(key) } < 0 {
            return Err(format!("键 {key} 已在外部按住，不能取得它的释放权"));
        }
        // 先记账，部分投递失败或异常退出时 Drop 仍能发出释放事件。
        self.keys.push(key);
        send_key(key, false)
    }
    fn key_up(&mut self, key: i32) -> Result<(), String> {
        let index = self
            .keys
            .iter()
            .position(|v| *v == key)
            .ok_or("不能释放本序列未按下的键")?;
        send_key(key, true)?;
        self.keys.remove(index);
        Ok(())
    }
    fn mouse_down(&mut self, button: &str) -> Result<(), String> {
        if self.buttons.iter().any(|v| v == button) {
            return Err("鼠标键已经按下".into());
        }
        if unsafe { GetAsyncKeyState(mouse_code(button)) } < 0 {
            return Err("鼠标键已在外部按住".into());
        }
        self.buttons.push(button.to_string());
        send_mouse(mouse_flags(button)?.0, 0)
    }
    fn mouse_up(&mut self, button: &str) -> Result<(), String> {
        let index = self
            .buttons
            .iter()
            .position(|v| v == button)
            .ok_or("不能释放本序列未按下的鼠标键")?;
        send_mouse(mouse_flags(button)?.1, 0)?;
        self.buttons.remove(index);
        Ok(())
    }
    fn release(&mut self) -> Result<(), String> {
        let mut errors = Vec::new();
        for button in self.buttons.clone().iter().rev() {
            if let Err(error) = self.mouse_up(button) {
                errors.push(error);
            }
        }
        for key in self.keys.clone().iter().rev() {
            if let Err(error) = self.key_up(*key) {
                errors.push(error);
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
}
impl Drop for Held {
    fn drop(&mut self) {
        let _ = self.release();
    }
}

pub fn validate(steps: &[Step]) -> Result<(), String> {
    if steps.is_empty() || steps.len() > 256 {
        return Err("输入序列需要 1..256 步".into());
    }
    let mut keys = Vec::new();
    let mut buttons = Vec::new();
    let mut duration = 0i64;
    let mut text_units = 0usize;
    for step in steps {
        match step {
            Step::KeyDown { key } => {
                virtual_key(*key)?;
                if keys.contains(key) {
                    return Err("重复 keyDown".into());
                }
                keys.push(*key);
            }
            Step::KeyUp { key } => {
                let index = keys
                    .iter()
                    .position(|v| v == key)
                    .ok_or("keyUp 没有对应 keyDown")?;
                keys.remove(index);
            }
            Step::MouseDown { button } => {
                mouse_flags(button)?;
                if buttons.contains(button) {
                    return Err("重复 mouseDown".into());
                }
                buttons.push(button.clone());
            }
            Step::MouseUp { button } => {
                let index = buttons
                    .iter()
                    .position(|v| v == button)
                    .ok_or("mouseUp 没有对应 mouseDown")?;
                buttons.remove(index);
            }
            Step::Wait { ms } => {
                if !(0..=10_000).contains(ms) {
                    return Err("wait 时长必须 0..10000 ms".into());
                }
                duration += ms;
            }
            Step::Key {
                key,
                modifiers,
                repeat,
                hold_ms,
            } => {
                virtual_key(*key)?;
                if !(1..=100).contains(repeat)
                    || !(0..=10_000).contains(hold_ms)
                    || modifiers.len() > 8
                {
                    return Err("key repeat/hold/modifiers 超过界限".into());
                }
                let mut seen = vec![*key];
                if keys.contains(key) {
                    return Err("key 与已持有键重叠".into());
                }
                for modifier in modifiers {
                    virtual_key(*modifier)?;
                    if seen.contains(modifier) || keys.contains(modifier) {
                        return Err("key 修饰键重复或与已持有键重叠".into());
                    }
                    seen.push(*modifier);
                }
                duration += hold_ms * i64::from(*repeat);
            }
            Step::Type { text } => {
                if !keys.is_empty() {
                    return Err("type 不能与已持有键混用".into());
                }
                text_units += text.encode_utf16().count();
            }
            Step::Scroll {
                delta_x, delta_y, ..
            } => {
                if delta_x.abs_diff(0) > 120_000 || delta_y.abs_diff(0) > 120_000 {
                    return Err("scroll delta 超过 120000".into());
                }
            }
            Step::Move { .. } => (),
        }
    }
    if duration > 10_000 || text_units > 100_000 {
        return Err("输入序列总等待超过 10 秒或文本超过 100000 UTF-16 单元".into());
    }
    Ok(())
}

pub fn execute(
    steps: &[Step],
    check_target: impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    validate(steps)?;
    let mut held = Held::default();
    let result = (|| {
        for (index, step) in steps.iter().enumerate() {
            check_target().map_err(|error| format!("step {index}: {error}"))?;
            let result = match step {
                Step::Move { x, y } => pointer_move(*x, *y),
                Step::MouseDown { button } => held.mouse_down(button),
                Step::MouseUp { button } => held.mouse_up(button),
                Step::KeyDown { key } => held.key_down(*key),
                Step::KeyUp { key } => held.key_up(*key),
                Step::Wait { ms } => {
                    sleep_ms(*ms);
                    Ok(())
                }
                Step::Type { text } => type_text(text),
                Step::Scroll {
                    x,
                    y,
                    delta_x,
                    delta_y,
                } => {
                    pointer_move(*x, *y)?;
                    if *delta_x != 0 {
                        send_mouse(MOUSEEVENTF_HWHEEL, *delta_x)?;
                    }
                    if *delta_y != 0 {
                        send_mouse(MOUSEEVENTF_WHEEL, *delta_y)?;
                    }
                    Ok(())
                }
                Step::Key {
                    key,
                    modifiers,
                    repeat,
                    hold_ms,
                } => {
                    for modifier in modifiers {
                        held.key_down(*modifier)?;
                    }
                    for _ in 0..*repeat {
                        held.key_down(*key)?;
                        sleep_ms(*hold_ms);
                        held.key_up(*key)?;
                    }
                    for modifier in modifiers.iter().rev() {
                        held.key_up(*modifier)?;
                    }
                    Ok(())
                }
            };
            result.map_err(|error| format!("step {index}: {error}"))?;
        }
        Ok(())
    })();
    let release = held.release();
    match (result, release) {
        (Err(error), Err(cleanup)) => Err(format!("{error}; 释放输入失败: {cleanup}")),
        (Err(error), _) | (_, Err(error)) => Err(error),
        _ => Ok(()),
    }
}

pub fn tap(key: i32, modifiers: &[i32]) -> Result<(), String> {
    execute(
        &[Step::Key {
            key,
            modifiers: modifiers.to_vec(),
            repeat: 1,
            hold_ms: 0,
        }],
        || Ok(()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_late_invalid_step_before_input() {
        let steps = vec![
            Step::MouseDown {
                button: "left".into(),
            },
            Step::Wait { ms: 10_001 },
        ];
        assert!(validate(&steps).is_err());
        assert!(validate(&[Step::KeyUp { key: 17 }]).is_err());
    }
    #[test]
    fn allows_held_inputs_at_end_for_automatic_release() {
        assert!(validate(&[
            Step::KeyDown { key: 17 },
            Step::MouseDown {
                button: "left".into()
            }
        ])
        .is_ok());
    }
    #[test]
    fn enforces_total_duration_and_duplicate_keys() {
        assert!(validate(&[Step::Wait { ms: 6000 }, Step::Wait { ms: 6000 }]).is_err());
        assert!(validate(&[Step::Key {
            key: 17,
            modifiers: vec![17],
            repeat: 1,
            hold_ms: 0
        }])
        .is_err());
    }
}
