//! Device probe for the Android PTY transport. This executable is never packaged.
#[cfg(not(target_os = "android"))]
fn main() {
    eprintln!("This probe requires an Android NDK target");
    std::process::exit(2);
}

#[cfg(target_os = "android")]
fn main() -> std::io::Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [] => android::run(17),
        [flag] if flag == "--negative-control" => android::run(18),
        _ => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "usage: dsh-native-pty-probe [--negative-control]",
        )),
    }
}

#[cfg(target_os = "android")]
mod android {
    use std::fs::File;
    use std::io::{self, Read, Write};
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::time::{Duration, Instant};

    struct Child(libc::pid_t);

    impl Child {
        fn wait(&mut self, deadline: Instant) -> io::Result<i32> {
            loop {
                let mut status = 0;
                // SAFETY: status is writable and self.0 names our unreaped child.
                let got = unsafe { libc::waitpid(self.0, &mut status, libc::WNOHANG) };
                if got == self.0 {
                    self.0 = 0;
                    return Ok(status);
                }
                if got < 0 {
                    let error = io::Error::last_os_error();
                    if error.kind() != io::ErrorKind::Interrupted {
                        // ECHILD means there is no longer a child for Drop to signal.
                        if error.raw_os_error() == Some(libc::ECHILD) {
                            self.0 = 0;
                        }
                        return Err(error);
                    }
                }
                if Instant::now() >= deadline {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "PTY child did not exit",
                    ));
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    }

    impl Drop for Child {
        fn drop(&mut self) {
            if self.0 <= 0 {
                return;
            }
            // SAFETY: this guard owns the child until waitpid reaps it.
            unsafe {
                libc::kill(self.0, libc::SIGKILL);
                loop {
                    let got = libc::waitpid(self.0, std::ptr::null_mut(), 0);
                    if got >= 0 || io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                        break;
                    }
                }
            }
        }
    }

    fn size(rows: u16, cols: u16) -> libc::winsize {
        libc::winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        }
    }

    fn poll_read(master: &File, deadline: Instant) -> io::Result<()> {
        let mut pollfd = libc::pollfd {
            fd: master.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "PTY output timed out",
                ));
            }
            // SAFETY: pollfd is valid and one entry is supplied.
            let ready = unsafe { libc::poll(&mut pollfd, 1, remaining.as_millis().max(1) as i32) };
            if ready > 0 {
                return Ok(());
            }
            if ready < 0 {
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::Interrupted {
                    return Err(error);
                }
            }
        }
    }

    fn expect(master: &mut File, needle: &[u8], deadline: Instant) -> io::Result<()> {
        let mut buffer = Vec::new();
        let mut chunk = [0; 4096];
        while buffer.len() < 64 * 1024 {
            poll_read(master, deadline)?;
            let n = master.read(&mut chunk)?;
            if n == 0 {
                break;
            }
            buffer.extend_from_slice(&chunk[..n]);
            if buffer.windows(needle.len()).any(|window| window == needle) {
                return Ok(());
            }
        }
        Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "missing {:?}; output: {:?}",
                String::from_utf8_lossy(needle),
                String::from_utf8_lossy(&buffer)
            ),
        ))
    }

    pub fn run(expected_exit: i32) -> io::Result<()> {
        // Pass split literals through the TTY; their joined marker cannot be matched by command echo.
        let command = c"test -t 0 && test -t 1 || exit 3; printf 'dsh-%s\\n' 'ready'; IFS= read -r line || exit 4; printf 'recv:%s\\n' \"$line\"; stty size; exit 17";
        let shell = c"/system/bin/sh";
        let argv = [
            shell.as_ptr(),
            c"-c".as_ptr(),
            command.as_ptr(),
            std::ptr::null(),
        ];
        let envp = [
            c"PATH=/system/bin".as_ptr(),
            c"TERM=xterm-256color".as_ptr(),
            std::ptr::null(),
        ];
        let start = Instant::now();
        let deadline = start + Duration::from_secs(5);
        let mut fd = -1;
        // SAFETY: output fd and size are valid. The child only calls execve and _exit.
        let pid = unsafe {
            let pid = libc::forkpty(
                &mut fd,
                std::ptr::null_mut(),
                std::ptr::null(),
                &size(24, 80),
            );
            if pid == 0 {
                libc::execve(shell.as_ptr(), argv.as_ptr(), envp.as_ptr());
                libc::_exit(127);
            }
            pid
        };
        if pid < 0 {
            return Err(io::Error::last_os_error());
        }
        let mut child = Child(pid);
        // SAFETY: forkpty provided exclusive ownership of the master file descriptor.
        let mut master = unsafe { File::from_raw_fd(fd) };
        expect(&mut master, b"dsh-ready", deadline)?;
        let ready = start.elapsed();
        // SAFETY: the fd remains open; ioctl reads the live winsize for this call.
        if unsafe { libc::ioctl(master.as_raw_fd(), libc::TIOCSWINSZ, &size(31, 103)) } < 0 {
            return Err(io::Error::last_os_error());
        }
        master.write_all("中文 PTY\r".as_bytes())?;
        expect(&mut master, "recv:中文 PTY\r\n31 103".as_bytes(), deadline)?;
        let status = child.wait(deadline)?;
        if !libc::WIFEXITED(status) || libc::WEXITSTATUS(status) != expected_exit {
            return Err(io::Error::other(format!(
                "unexpected child status: {status}"
            )));
        }
        println!(
            "android_native_pty_ok ready_us={} total_us={} arch={} exit=17 rows=31 cols=103",
            ready.as_micros(),
            start.elapsed().as_micros(),
            std::env::consts::ARCH
        );
        Ok(())
    }
}
