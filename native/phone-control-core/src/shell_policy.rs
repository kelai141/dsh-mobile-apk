//! Shell admission is native-owned. Display actions use the typed screen tools.
//! This lexer deliberately rejects runtime expansion in the Shizuku query channel.

pub fn bounded(command: &str) -> bool {
    !command.trim().is_empty() && command.len() <= 16_384 && !command.contains('\0')
}

fn segments(command: &str) -> Option<Vec<Vec<String>>> {
    let mut result = Vec::new();
    let mut words = Vec::new();
    let mut word = String::new();
    let mut quote = None;
    let mut escaped = false;
    for ch in command.chars() {
        if escaped { word.push(ch); escaped = false; continue; }
        if ch == '\\' && quote != Some('\'') { escaped = true; continue; }
        if quote == Some(ch) { quote = None; continue; }
        if quote.is_none() && matches!(ch, '\'' | '"') { quote = Some(ch); continue; }
        if quote != Some('\'') && matches!(ch, '$' | '`') { return None; }
        if quote.is_none() {
            if matches!(ch, '<' | '>' | '(' | ')' | '{' | '}' | '\n' | '\r') { return None; }
            if ch.is_whitespace() || matches!(ch, ';' | '|' | '&') {
                if !word.is_empty() { words.push(std::mem::take(&mut word)); }
                if matches!(ch, ';' | '|' | '&') && !words.is_empty() {
                    result.push(std::mem::take(&mut words));
                }
                continue;
            }
        }
        word.push(ch);
    }
    if quote.is_some() || escaped { return None; }
    if !word.is_empty() { words.push(word); }
    if !words.is_empty() { result.push(words); }
    (!result.is_empty()).then_some(result)
}

pub fn shizuku_query(command: &str) -> bool {
    if !bounded(command) { return false; }
    let Some(parts) = segments(command) else { return false; };
    parts.iter().all(|argv| {
        let head = argv[0].strip_prefix("/system/bin/").unwrap_or(&argv[0]);
        let args: Vec<_> = argv.iter().skip(1).map(String::as_str).collect();
        match head {
            "id" | "whoami" | "uname" | "uptime" | "date" | "getprop" | "ls" | "stat" |
            "cat" | "head" | "tail" | "wc" | "cut" | "sort" | "uniq" | "tr" | "grep" |
            "egrep" | "fgrep" | "df" | "du" | "ps" | "pidof" | "printenv" | "echo" => true,
            "find" => !args.iter().any(|arg| matches!(*arg, "-exec" | "-execdir" | "-ok" | "-okdir" | "-delete" | "-fprint" | "-fprintf" | "-fls")),
            "logcat" => args.contains(&"-d") && !args.iter().any(|arg| matches!(*arg, "-c" | "-f" | "--clear" | "--file")),
            "dumpsys" => !args.iter().any(|arg| matches!(*arg, "--enable" | "--disable" | "--reset" | "--write" | "--proto")) &&
                args.iter().all(|arg| arg.starts_with('-') || arg.parse::<u32>().is_ok() ||
                    matches!(*arg, "activity" | "activities" | "processes" | "services" | "window" | "windows" |
                        "display" | "input" | "input_method" | "package" | "battery" | "meminfo" | "cpuinfo" |
                        "power" | "notification" | "connectivity" | "wifi" | "accessibility" | "SurfaceFlinger")),
            "pm" => matches!(args.first(), Some(&"list") | Some(&"path") | Some(&"dump")),
            "settings" => matches!(args.first(), Some(&"get") | Some(&"list")),
            "wm" => matches!(args.as_slice(), ["size"] | ["density"] | ["help"]),
            "cmd" => matches!(args.as_slice(), ["package", "list", ..] | ["package", "path", ..] | ["appops", "get", ..]),
            _ => false,
        }
    })
}

pub fn reads_display(command: &str) -> bool {
    segments(command).is_none_or(|parts| parts.iter().any(|argv| {
        argv[0].ends_with("dumpsys") && argv.iter().any(|word|
            matches!(word.as_str(), "activity" | "window" | "windows" | "input" | "input_method" | "accessibility" | "SurfaceFlinger"))
    }))
}

/// Termux remains an application-UID channel. Preserve its existing danger floor.
pub fn termux(command: &str) -> bool {
    if !bounded(command) { return false; }
    let lower = command.to_ascii_lowercase();
    let words: Vec<_> = lower.split(|ch: char| !ch.is_ascii_alphanumeric() && !matches!(ch, '/' | '.' | '-' | '_')).filter(|word| !word.is_empty()).collect();
    if words.iter().any(|word| matches!(*word, "mkfs" | "mkfs.ext4" | "mkfs.ext2" | "mkfs.f2fs" | "mkfs.xfs" |
        "reboot" | "shutdown" | "poweroff" | "halt" | "wipe" | "wipefs" | "wipeall")) { return false; }
    if words.windows(2).any(|pair| pair == ["pm", "uninstall"] || pair == ["svc", "power"] || pair == ["svc", "netd"] || pair == ["svc", "crypto"]) { return false; }
    if lower.contains("of=/dev/") || lower.contains("of=/system/") || lower.contains(":(){") || lower.contains(": () {") { return false; }
    !words.windows(3).any(|part| part[0] == "rm" && part[1].starts_with('-') && part[1].contains('r') &&
        matches!(part[2], "/" | "/system" | "/data" | "/dev"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn queries_preserve_system_inspection_without_a_shell_escape() {
        for command in ["getprop", "dumpsys activity activities | grep mResumedActivity", "pm list packages -3", "settings get secure default_input_method", "logcat -d -t 50", "ls /sdcard", "cat /proc/meminfo", "wm size", "find /sdcard -name '*.txt'"] {
            assert!(shizuku_query(command), "{command}");
        }
        for command in ["settings put global wifi_on 1", "echo x; reboot", "id; sh -c 'input tap 1 2'", "cat $(id)", "find /sdcard -exec rm {} ;", "dumpsys battery set level 3", "logcat -d -f /sdcard/a", "input tap 1 2", "screencap -p", "wm size 100x100", "cat /proc/meminfo > /sdcard/a"] {
            assert!(!shizuku_query(command), "{command}");
        }
    }
    #[test]
    fn termux_and_root_commands_are_bounded() {
        assert!(termux("printf hello; ls"));
        assert!(!termux("echo x; reboot"));
        assert!(!termux("pm uninstall example.app"));
        assert!(!bounded("id\0ignored"));
    }
}
