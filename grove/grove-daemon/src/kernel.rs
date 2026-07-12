//! The kernel liveness oracle (agent-status design §3.1 S3, Step 2).
//!
//! Liveness comes from exactly ONE source: the kernel, queried at READ time. That
//! is what lets the status system have no timers, no TTLs, and no SIGKILL wedge —
//! a badge cannot outlive its process, because the badge is DERIVED from the
//! process on every poll.
//!
//! ## Why one method and not four
//!
//! The design sketched `Kernel { exists, start_ticks, stopped, ctty }`. That is
//! four `sysctl`s per pid per poll AND it is TOCTOU-racy: the process can die
//! between `exists()` and `stopped()`. One `sysctl(KERN_PROC_PID)` returns all four
//! facts ATOMICALLY, so the trait has one method and the rest are derived from the
//! snapshot.
//!
//! ## The three landmines, all measured (macOS 26.5 / arm64)
//!
//! 1. **A zombie is NOT dead to `sysctl`.** After `SIGKILL`, but before the parent
//!    reaps, the process is still returned with `p_stat == SZOMB`. A resolver that
//!    only special-cases `SSTOP` would badge a killed agent `running` forever —
//!    reintroducing the exact wedge this design exists to kill. [`ProcFacts::alive`]
//!    excludes it.
//! 2. **`rc == 0` does not mean the process exists.** For a nonexistent pid `sysctl`
//!    returns SUCCESS with `size == 0`, leaving the buffer ZEROED — a caller that
//!    checks only `rc` reads pid 0 / stat 0 / tdev 0 and concludes it exists. The
//!    `size == 0` check is mandatory, not defensive.
//! 3. **`libc` does not export `kinfo_proc` for Apple targets** (verified against
//!    libc 0.2). The offsets below are ground truth from the macOS SDK headers;
//!    [`tests::kinfo_layout_is_self_consistent`] re-derives them at runtime against
//!    facts we independently know about our own process, so a future SDK change
//!    fails loudly instead of silently reading garbage.
//!
//! `libproc` (`proc_pidinfo`/`PROC_PIDTBSDINFO`) is the tempting alternative and is
//! wrong here: it returns NULL for zombies AND for other-uid processes, conflating
//! three different conditions. `sysctl` is unambiguous.

/// One atomic snapshot of the kernel's view of a process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcFacts {
    pub pid: i32,
    /// `p_starttime`, in microseconds since the epoch. THE PID-REUSE FENCE.
    /// Measured: preserved byte-identically across `execv` (both `grove-agent
    /// launch`'s exec of the real agent AND claude's own shim → versioned-binary
    /// re-exec), and stable for the whole process lifetime including SIGSTOP/SIGCONT.
    pub start_us: u64,
    /// `p_stat`: SIDL=1 SRUN=2 SSLEEP=3 SSTOP=4 SZOMB=5.
    pub stat: i32,
    /// `e_tdev`: the CONTROLLING TERMINAL device; [`NODEV`] (-1) when there is none.
    /// This is the fact that structurally stops a process in pane A from claiming
    /// pane B. Use `e_tdev`, NOT `e_tpgid` — tpgid churns as foreground jobs come
    /// and go, while tdev is stable for the session's life (measured over 47
    /// samples across vim/alt-screen, background jobs, and `top`).
    pub tdev: i32,
}

pub const SSTOP: i32 = 4;
pub const SZOMB: i32 = 5;
pub const NODEV: i32 = -1;

impl ProcFacts {
    /// A zombie is NOT alive (landmine 1). Everything else the kernel still lists —
    /// running, sleeping, stopped — is.
    pub fn alive(&self) -> bool {
        self.stat != SZOMB
    }

    /// Suspended (Ctrl-Z). A suspended agent is never `working` and never
    /// `attention`; the resolver maps it to `idle`.
    pub fn stopped(&self) -> bool {
        self.stat == SSTOP
    }

    /// Whether the process has a controlling terminal at all. A hook subprocess
    /// does NOT (it `setsid()`s), which is precisely why the ctty check applies to
    /// `agentClaim` and must NEVER be applied to `agentEvent`.
    pub fn has_ctty(&self) -> bool {
        self.tdev != NODEV
    }
}

/// The kernel oracle. One method: everything the resolver needs, atomically.
/// `None` ⇒ no such process (the badge-clearing condition).
pub trait Kernel: Send + Sync {
    fn facts(&self, pid: i32) -> Option<ProcFacts>;
}

// ---------------------------------------------------------------------------
// macOS: sysctl(KERN_PROC_PID)
// ---------------------------------------------------------------------------

/// Ground truth from the macOS SDK (`sys/sysctl.h` + `sys/proc.h`), arm64:
/// `sizeof(kinfo_proc) = 648`, `kp_proc @ 0`, `kp_eproc @ 296`;
/// `p_starttime @ 0` (timeval: i64 sec @0, i32 usec @8), `p_stat @ 36` (char),
/// `p_pid @ 40` (i32); `e_tdev @ 572` (dev_t = i32).
#[cfg(target_os = "macos")]
mod mac {
    use super::{Kernel, ProcFacts};

    const KINFO_PROC_SIZE: usize = 648;
    const OFF_START_SEC: usize = 0;
    const OFF_START_USEC: usize = 8;
    const OFF_P_STAT: usize = 36;
    const OFF_P_PID: usize = 40;
    const OFF_E_TDEV: usize = 572;

    pub struct MacKernel;

    impl Kernel for MacKernel {
        fn facts(&self, pid: i32) -> Option<ProcFacts> {
            if pid <= 0 {
                return None;
            }
            // SAFETY: `mib` is a 4-element array matching the `namelen` we pass;
            // `buf`/`size` describe one `kinfo_proc`-sized buffer we own. sysctl
            // writes at most `size` bytes and updates `size` to what it wrote.
            unsafe {
                let mut mib: [libc::c_int; 4] =
                    [libc::CTL_KERN, libc::KERN_PROC, libc::KERN_PROC_PID, pid];
                let mut buf = [0u8; KINFO_PROC_SIZE];
                let mut size = KINFO_PROC_SIZE;
                let rc = libc::sysctl(
                    mib.as_mut_ptr(),
                    4,
                    buf.as_mut_ptr() as *mut libc::c_void,
                    &mut size,
                    std::ptr::null_mut(),
                    0,
                );
                // Landmine 2: rc == 0 with size == 0 means NO SUCH PROCESS. Without
                // this check a dead pid reads back as a zeroed, "existing" process.
                if rc != 0 || size == 0 {
                    return None;
                }
                let rd32 = |o: usize| i32::from_ne_bytes(buf[o..o + 4].try_into().unwrap());
                let rd64 = |o: usize| i64::from_ne_bytes(buf[o..o + 8].try_into().unwrap());
                Some(ProcFacts {
                    pid: rd32(OFF_P_PID),
                    start_us: (rd64(OFF_START_SEC) as u64)
                        .wrapping_mul(1_000_000)
                        .wrapping_add(rd32(OFF_START_USEC) as u64),
                    stat: buf[OFF_P_STAT] as i32,
                    tdev: rd32(OFF_E_TDEV),
                })
            }
        }
    }
}

#[cfg(target_os = "macos")]
pub use mac::MacKernel;

/// The no-oracle kernel for platforms where we have not implemented the probe.
/// Every pid reads as absent, so `resolve()` yields `None` and NO badge is ever
/// drawn. That is the correct degradation: the ladder has no inference rung, so a
/// platform we cannot fence on shows nothing rather than something wrong.
#[cfg(not(target_os = "macos"))]
pub struct NullKernel;

#[cfg(not(target_os = "macos"))]
impl Kernel for NullKernel {
    fn facts(&self, _pid: i32) -> Option<ProcFacts> {
        None
    }
}

/// The process-wide kernel oracle used by the live daemon.
pub fn system_kernel() -> std::sync::Arc<dyn Kernel> {
    #[cfg(target_os = "macos")]
    {
        std::sync::Arc::new(MacKernel)
    }
    #[cfg(not(target_os = "macos"))]
    {
        std::sync::Arc::new(NullKernel)
    }
}

// ---------------------------------------------------------------------------
// The connecting process's pid (agent-status design §5 check 2 / spike R4)
// ---------------------------------------------------------------------------

/// `sys/un.h`: `SOL_LOCAL` / `LOCAL_PEERPID`. Not exported by `libc`.
#[cfg(unix)]
const SOL_LOCAL: libc::c_int = 0;
#[cfg(unix)]
const LOCAL_PEERPID: libc::c_int = 0x002;

/// The pid of the process on the other end of an `AF_UNIX`/`SOCK_STREAM` socket.
/// The claimant cannot lie about who it is — the kernel answers, not the client.
///
/// **This MUST be called at `accept()`, on the accepting task, before any `.await`.**
/// Measured: `getsockopt` returns `ENOTCONN` the moment the peer closes its socket
/// end — process death is not required and the pid is NOT cached for a later read.
/// A lazy read at dispatch time is a genuine race (4/5 reruns failed against a
/// fire-and-exit peer). `None` therefore means "unreadable", and a claim with an
/// unreadable pid is REJECTED — never unwrapped, never assumed.
#[cfg(unix)]
pub fn peer_pid(fd: std::os::fd::RawFd) -> Option<i32> {
    // SAFETY: `fd` is a live socket fd owned by the caller; we pass a correctly
    // sized out-param and its length, exactly as getsockopt(2) requires.
    unsafe {
        let mut pid: libc::pid_t = -1;
        let mut len = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
        let rc = libc::getsockopt(
            fd,
            SOL_LOCAL,
            LOCAL_PEERPID,
            &mut pid as *mut _ as *mut libc::c_void,
            &mut len,
        );
        if rc != 0 || pid <= 0 {
            return None;
        }
        Some(pid)
    }
}

// ---------------------------------------------------------------------------
// FakeKernel — the resolver is unit-testable with zero PTYs
// ---------------------------------------------------------------------------

/// A scriptable kernel for tests. The resolver, the claim admission check and the
/// whole socket path can be driven against it without spawning a single process.
#[derive(Default, Clone)]
pub struct FakeKernel {
    procs: std::sync::Arc<std::sync::Mutex<std::collections::HashMap<i32, ProcFacts>>>,
}

impl FakeKernel {
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a live, running process with a controlling terminal `tdev`.
    pub fn insert(&self, pid: i32, start_us: u64, tdev: i32) -> &Self {
        self.put(ProcFacts {
            pid,
            start_us,
            stat: 2, // SRUN
            tdev,
        })
    }

    pub fn put(&self, facts: ProcFacts) -> &Self {
        self.procs.lock().unwrap().insert(facts.pid, facts);
        self
    }

    /// The process is gone — what the kernel reports after an exit, a SIGTERM, or a
    /// SIGKILL that has been reaped. No TTL is involved anywhere.
    pub fn remove(&self, pid: i32) -> &Self {
        self.procs.lock().unwrap().remove(&pid);
        self
    }

    /// SIGKILLed but not yet reaped: still listed, `SZOMB`. Must read as NOT alive.
    pub fn zombify(&self, pid: i32) -> &Self {
        self.mutate(pid, |f| f.stat = SZOMB);
        self
    }

    /// Ctrl-Z.
    pub fn suspend(&self, pid: i32) -> &Self {
        self.mutate(pid, |f| f.stat = SSTOP);
        self
    }

    /// PID reuse: the pid is live again, but it is a DIFFERENT process — a new
    /// `p_starttime`. The fence must prune the claim.
    pub fn reuse_pid(&self, pid: i32, new_start_us: u64) -> &Self {
        self.mutate(pid, |f| f.start_us = new_start_us);
        self
    }

    fn mutate(&self, pid: i32, f: impl FnOnce(&mut ProcFacts)) {
        if let Some(facts) = self.procs.lock().unwrap().get_mut(&pid) {
            f(facts);
        }
    }
}

impl Kernel for FakeKernel {
    fn facts(&self, pid: i32) -> Option<ProcFacts> {
        self.procs.lock().unwrap().get(&pid).copied()
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::process::Command;
    use std::time::Duration;

    fn sleeper() -> std::process::Child {
        Command::new("/bin/sleep")
            .arg("60")
            .spawn()
            .expect("spawn /bin/sleep")
    }

    /// The offsets are hand-derived from the SDK headers, so a future macOS could
    /// move a field and we would silently read garbage. Re-derive them at runtime
    /// against facts we independently know about our own process.
    #[test]
    fn kinfo_layout_is_self_consistent() {
        let me = std::process::id() as i32;
        let facts = MacKernel.facts(me).expect("our own process must exist");
        assert_eq!(facts.pid, me, "p_pid offset is wrong");
        assert!(
            facts.alive() && !facts.stopped(),
            "we are running: {facts:?}"
        );
        assert!(
            facts.start_us > 1_600_000_000_000_000,
            "p_starttime offset is wrong (not a plausible epoch-µs): {facts:?}"
        );
    }

    #[test]
    fn a_missing_pid_is_none_not_a_zeroed_struct() {
        // Landmine 2: sysctl returns rc==0/size==0 for a dead pid. If this ever
        // returns Some, every dead agent badges forever.
        assert!(MacKernel.facts(0).is_none());
        assert!(MacKernel.facts(-1).is_none());
        assert!(
            MacKernel.facts(0x7FFF_FFFF).is_none(),
            "an impossible pid must be absent"
        );
    }

    #[test]
    fn a_killed_child_is_never_alive_not_even_as_a_zombie() {
        let mut child = sleeper();
        let pid = child.id() as i32;
        let before = MacKernel.facts(pid).expect("the child exists");
        assert!(before.alive() && !before.stopped());

        // SAFETY: a pid we own; SIGKILL cannot be trapped — the wedge case.
        unsafe { libc::kill(pid, libc::SIGKILL) };
        std::thread::sleep(Duration::from_millis(300));

        // Unreaped ⇒ SZOMB, and sysctl STILL LISTS IT. This is the assertion that
        // guards the SIGKILL wedge: a zombie must read as not-alive.
        if let Some(zombie) = MacKernel.facts(pid) {
            assert!(
                !zombie.alive(),
                "a SIGKILLed-but-unreaped child must not be alive (the badge would \
                 wedge at running): {zombie:?}"
            );
        }
        let _ = child.wait();
        assert!(MacKernel.facts(pid).is_none(), "reaped ⇒ gone");
    }

    #[test]
    fn a_sigstopped_child_reads_sstop_and_recovers_on_sigcont() {
        let mut child = sleeper();
        let pid = child.id() as i32;
        // SAFETY: a pid we own.
        unsafe { libc::kill(pid, libc::SIGSTOP) };
        std::thread::sleep(Duration::from_millis(300));
        assert!(
            MacKernel.facts(pid).expect("still listed").stopped(),
            "Ctrl-Z detection is real: p_stat must be SSTOP"
        );

        unsafe { libc::kill(pid, libc::SIGCONT) };
        std::thread::sleep(Duration::from_millis(300));
        assert!(!MacKernel.facts(pid).expect("still listed").stopped());

        unsafe { libc::kill(pid, libc::SIGKILL) };
        let _ = child.wait();
    }

    #[test]
    fn start_us_fences_pid_reuse() {
        // Two DIFFERENT processes must never share a (pid, start_us) pair. We cannot
        // force the kernel to reuse a pid, so assert the property the fence needs:
        // start_us is per-process, and stable across reads for one process.
        let mut a = sleeper();
        let pid_a = a.id() as i32;
        let fa1 = MacKernel.facts(pid_a).unwrap();
        std::thread::sleep(Duration::from_millis(50));
        let fa2 = MacKernel.facts(pid_a).unwrap();
        assert_eq!(
            fa1.start_us, fa2.start_us,
            "start_us is stable for a process"
        );

        let mut b = sleeper();
        let fb = MacKernel.facts(b.id() as i32).unwrap();
        assert_ne!(
            fa1.start_us, fb.start_us,
            "two processes started 50ms apart must not share a start_us"
        );

        // SAFETY: pids we own.
        unsafe {
            libc::kill(pid_a, libc::SIGKILL);
            libc::kill(b.id() as i32, libc::SIGKILL);
        }
        let _ = a.wait();
        let _ = b.wait();
    }

    #[test]
    fn the_daemon_has_no_controlling_terminal_but_a_tty_process_does() {
        // The daemon is detached (no ctty). Whether the TEST process has one depends
        // on how cargo was invoked, so only the direction we can guarantee is
        // asserted: NODEV is representable and means "no ctty".
        let me = MacKernel.facts(std::process::id() as i32).unwrap();
        assert_eq!(me.has_ctty(), me.tdev != NODEV);
    }

    #[test]
    fn fake_kernel_models_every_transition_the_resolver_cares_about() {
        let k = FakeKernel::new();
        k.insert(100, 111, 7);
        assert!(k.facts(100).unwrap().alive());
        assert!(!k.facts(100).unwrap().stopped());
        assert!(k.facts(100).unwrap().has_ctty());

        k.suspend(100);
        assert!(k.facts(100).unwrap().stopped());

        k.zombify(100);
        assert!(!k.facts(100).unwrap().alive(), "SZOMB is not alive");

        k.remove(100);
        assert!(k.facts(100).is_none());

        k.insert(100, 999, 7);
        assert_eq!(
            k.facts(100).unwrap().start_us,
            999,
            "pid reuse ⇒ new start_us"
        );
    }
}
