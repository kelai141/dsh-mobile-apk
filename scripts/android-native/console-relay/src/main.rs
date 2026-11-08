#[cfg(not(target_os = "android"))]
fn main() {
    eprintln!("This relay requires an Android NDK target");
    std::process::exit(2);
}

#[cfg(target_os = "android")]
fn main() {
    if let Err(error) = android::run() {
        let _ = android::send(&serde_json::json!({"op":"error","message":error.to_string()}));
        std::process::exit(1);
    }
}

#[cfg(target_os = "android")]
mod android {
    use serde_json::{json, Value};
    use std::ffi::CString;
    use std::fs::File;
    use std::io::{self, Read, Write};
    use std::os::fd::{AsRawFd, FromRawFd, RawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::ptr;

    const MAX_BUFFER: usize = 4 * 1024 * 1024;
    const INPUT: RawFd = libc::STDIN_FILENO;

    fn last() -> io::Error {
        io::Error::last_os_error()
    }

    fn other(message: &str) -> io::Error {
        io::Error::other(message)
    }

    pub fn send(value: &Value) -> io::Result<()> {
        let mut out = io::stdout().lock();
        serde_json::to_writer(&mut out, value)?;
        out.write_all(b"\n")?;
        out.flush()
    }

    fn size(cols: u16, rows: u16) -> libc::winsize {
        libc::winsize {
            ws_col: cols,
            ws_row: rows,
            ws_xpixel: 0,
            ws_ypixel: 0,
        }
    }

    fn dimension(value: &Value, key: &str, default: u16) -> u16 {
        value[key]
            .as_u64()
            .and_then(|v| u16::try_from(v).ok())
            .filter(|&v| v != 0)
            .unwrap_or(default)
    }

    struct Child(libc::pid_t);

    impl Child {
        fn reap(&mut self, flags: libc::c_int) -> io::Result<Option<i32>> {
            loop {
                let mut status = 0;
                // SAFETY: self owns this child and status is writable.
                let result = unsafe { libc::waitpid(self.0, &mut status, flags) };
                if result > 0 {
                    self.0 = 0;
                    return Ok(Some(if libc::WIFEXITED(status) {
                        libc::WEXITSTATUS(status)
                    } else {
                        -1
                    }));
                }
                if result == 0 {
                    return Ok(None);
                }
                let error = last();
                if error.raw_os_error() == Some(libc::ECHILD) {
                    self.0 = 0;
                }
                if error.kind() != io::ErrorKind::Interrupted {
                    return Err(error);
                }
            }
        }
    }

    impl Drop for Child {
        fn drop(&mut self) {
            if self.0 > 0 {
                // SAFETY: the child is still owned. Closing the master hangs up the foreground job.
                unsafe { libc::kill(self.0, libc::SIGKILL) };
                let _ = self.reap(0);
            }
        }
    }

    fn child_signal() -> io::Result<(File, libc::sigset_t)> {
        // SAFETY: the masks are initialized here and the relay is single-threaded.
        unsafe {
            let mut mask = std::mem::zeroed();
            let mut old = std::mem::zeroed();
            libc::sigemptyset(&mut mask);
            libc::sigaddset(&mut mask, libc::SIGCHLD);
            if libc::sigprocmask(libc::SIG_BLOCK, &mask, &mut old) != 0 {
                return Err(last());
            }
            let fd = libc::signalfd(-1, &mask, libc::SFD_CLOEXEC | libc::SFD_NONBLOCK);
            if fd < 0 {
                return Err(last());
            }
            Ok((File::from_raw_fd(fd), old))
        }
    }

    fn spawn(
        shell: &CString,
        cwd: &CString,
        cols: u16,
        rows: u16,
        mask: &libc::sigset_t,
    ) -> io::Result<(Child, File)> {
        let args = [shell.as_ptr(), c"-i".as_ptr(), ptr::null()];
        let mut pipe = [-1; 2];
        // SAFETY: pipe points to two writable descriptors.
        if unsafe { libc::pipe2(pipe.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
            return Err(last());
        }
        // SAFETY: pipe2 transferred both unique descriptors.
        let (mut exec_read, exec_write) =
            unsafe { (File::from_raw_fd(pipe[0]), File::from_raw_fd(pipe[1])) };
        let mut fd = -1;
        // SAFETY: pointers remain live. The forked child uses only libc before exec and never runs destructors.
        let pid = unsafe {
            let parent = libc::getpid();
            let pid = libc::forkpty(&mut fd, ptr::null_mut(), ptr::null(), &size(cols, rows));
            if pid == 0 {
                libc::close(pipe[0]);
                let errno = if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGHUP, 0, 0, 0) != 0 {
                    *libc::__errno()
                } else if libc::getppid() != parent {
                    libc::ECHILD
                } else if libc::sigprocmask(libc::SIG_SETMASK, mask, ptr::null_mut()) != 0
                    || libc::chdir(cwd.as_ptr()) != 0
                {
                    *libc::__errno()
                } else {
                    libc::execv(shell.as_ptr(), args.as_ptr());
                    *libc::__errno()
                };
                libc::write(
                    pipe[1],
                    (&errno as *const libc::c_int).cast(),
                    std::mem::size_of_val(&errno),
                );
                libc::_exit(127);
            }
            pid
        };
        if pid < 0 {
            return Err(last());
        }
        let child = Child(pid);
        // SAFETY: forkpty returned ownership of the master in the parent.
        let master = unsafe { File::from_raw_fd(fd) };
        drop(exec_write);
        let mut status = Vec::new();
        exec_read.read_to_end(&mut status)?;
        if !status.is_empty() {
            return Err(status
                .try_into()
                .map(i32::from_ne_bytes)
                .map(io::Error::from_raw_os_error)
                .unwrap_or_else(|_| other("truncated exec status")));
        }
        // SAFETY: fd is live and only this relay accesses its flags.
        if unsafe { libc::fcntl(fd, libc::F_SETFL, libc::O_NONBLOCK) } < 0 {
            return Err(last());
        }
        Ok((child, master))
    }

    fn emit_utf8(carry: &mut Vec<u8>, data: &[u8], eof: bool) -> io::Result<()> {
        carry.extend_from_slice(data);
        let mut consumed = 0;
        while consumed < carry.len() {
            let tail = &carry[consumed..];
            match std::str::from_utf8(tail) {
                Ok(text) => {
                    send(&json!({"op":"data","data":text}))?;
                    consumed = carry.len();
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    if valid > 0 {
                        send(
                            &json!({"op":"data","data":std::str::from_utf8(&tail[..valid]).unwrap()}),
                        )?;
                        consumed += valid;
                    }
                    match error.error_len() {
                        Some(n) => {
                            send(&json!({"op":"data","data":"�"}))?;
                            consumed += n;
                        }
                        None if eof => {
                            send(&json!({"op":"data","data":"�"}))?;
                            consumed = carry.len();
                        }
                        None => break,
                    }
                }
            }
        }
        carry.drain(..consumed);
        Ok(())
    }

    pub fn run() -> io::Result<()> {
        let env = |key| std::env::var_os(key).ok_or_else(|| other("missing console environment"));
        let shell = CString::new(env("DSH_CONSOLE_SHELL")?.as_bytes())?;
        let cwd = CString::new(env("HOME")?.as_bytes())?;
        let read_size = |key, fallback| {
            std::env::var(key)
                .ok()
                .and_then(|v| v.parse::<u16>().ok())
                .filter(|&v| v > 0)
                .unwrap_or(fallback)
        };
        let cols = read_size("DSH_CONSOLE_COLS", 80);
        let rows = read_size("DSH_CONSOLE_ROWS", 24);
        let (mut child_signal, mask) = child_signal()?;
        let (mut child, mut master) = spawn(&shell, &cwd, cols, rows, &mask)?;
        send(&json!({"op":"ready","pid":child.0,"cols":cols,"rows":rows}))?;
        let mut input = Vec::new();
        let mut pending = Vec::new();
        let mut utf8 = Vec::new();
        let mut buffer = [0; 8192];
        let mut code = loop {
            let mut poll = [
                libc::pollfd {
                    fd: INPUT,
                    events: libc::POLLIN,
                    revents: 0,
                },
                libc::pollfd {
                    fd: master.as_raw_fd(),
                    events: libc::POLLIN | if pending.is_empty() { 0 } else { libc::POLLOUT },
                    revents: 0,
                },
                libc::pollfd {
                    fd: child_signal.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                },
            ];
            // SAFETY: poll points at initialized entries.
            if unsafe { libc::poll(poll.as_mut_ptr(), poll.len() as libc::nfds_t, -1) } < 0 {
                let error = last();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error);
            }
            if poll[1].revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0 {
                match master.read(&mut buffer) {
                    Ok(0) => break None,
                    Ok(n) => emit_utf8(&mut utf8, &buffer[..n], false)?,
                    Err(error) if error.raw_os_error() == Some(libc::EIO) => break None,
                    Err(error)
                        if matches!(
                            error.kind(),
                            io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
                        ) => {}
                    Err(error) => return Err(error),
                }
            }
            if poll[1].revents & libc::POLLOUT != 0 && !pending.is_empty() {
                match master.write(&pending) {
                    Ok(n) => {
                        pending.drain(..n);
                    }
                    Err(error)
                        if matches!(
                            error.kind(),
                            io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
                        ) => {}
                    Err(error) if error.raw_os_error() == Some(libc::EIO) => break None,
                    Err(error) => return Err(error),
                }
            }
            if poll[0].revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0 {
                // SAFETY: buffer is writable; this is the only reader of stdin.
                let n = unsafe { libc::read(INPUT, buffer.as_mut_ptr().cast(), buffer.len()) };
                if n == 0 {
                    return Ok(());
                }
                if n < 0 {
                    let error = last();
                    if error.kind() == io::ErrorKind::Interrupted {
                        continue;
                    }
                    return Err(error);
                }
                input.extend_from_slice(&buffer[..n as usize]);
                let mut start = 0;
                while let Some(end) = input[start..]
                    .iter()
                    .position(|&v| v == b'\n')
                    .map(|v| v + start)
                {
                    if let Ok(value) = serde_json::from_slice::<Value>(&input[start..end]) {
                        match value["op"].as_str() {
                            Some("write") => {
                                if let Some(data) = value["data"].as_str() {
                                    if pending.len() + data.len() > MAX_BUFFER {
                                        return Err(other("console write backlog exceeded"));
                                    }
                                    pending.extend_from_slice(data.as_bytes());
                                }
                            }
                            Some("resize") => {
                                let geometry = size(
                                    dimension(&value, "cols", cols),
                                    dimension(&value, "rows", rows),
                                );
                                // SAFETY: fd is live and geometry has the ioctl's expected type.
                                if unsafe {
                                    libc::ioctl(master.as_raw_fd(), libc::TIOCSWINSZ, &geometry)
                                } < 0
                                {
                                    return Err(last());
                                }
                            }
                            Some("kill") => return Ok(()),
                            _ => {}
                        }
                    }
                    start = end + 1;
                }
                input.drain(..start);
                if input.len() > MAX_BUFFER {
                    return Err(other("console frame exceeded"));
                }
            }
            if poll[2].revents & libc::POLLIN != 0 {
                match child_signal.read(&mut buffer) {
                    Ok(_) => {}
                    Err(e)
                        if matches!(
                            e.kind(),
                            io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
                        ) => {}
                    Err(e) => return Err(e),
                }
                if let Some(code) = child.reap(libc::WNOHANG)? {
                    // Exit is independent of PTY EOF: a background job can still own the slave.
                    // Drain queued output, but don't let a surviving writer prevent exit.
                    for _ in 0..128 {
                        match master.read(&mut buffer) {
                            Ok(n) if n != 0 => emit_utf8(&mut utf8, &buffer[..n], false)?,
                            _ => break,
                        }
                    }
                    break Some(code);
                }
            }
        };
        emit_utf8(&mut utf8, &[], true)?;
        // A command may close all TTY handles without exiting. Do not wait forever in that case.
        drop(master);
        if code.is_none() {
            for _ in 0..20 {
                code = child.reap(libc::WNOHANG)?;
                if code.is_some() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        }
        send(&json!({"op":"exit","code":code.unwrap_or(-1)}))
    }
}
