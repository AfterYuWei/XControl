// 防止 Windows release 构建弹出额外的控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    eizhu_lib::run()
}
