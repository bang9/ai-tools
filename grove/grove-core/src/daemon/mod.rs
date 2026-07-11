//! PTY daemon protocol surface (design §1 / §2.4 / P1).
//!
//! This module is the wire contract shared by the daemon binary and the
//! in-process client that will slot under `pty.rs`'s pub fns. It is split by
//! channel to enforce design invariant #9 ("binary on the hot path, JSON on the
//! control path"):
//!
//! - [`protocol`] — the CONTROL channel: versioned endpoint paths, the hello
//!   handshake, RPC/notify envelopes, and the pid file, serialized as NDJSON.
//! - [`framing`] — the STREAM channel: the length-prefixed binary GCKL frame
//!   codec for `Data`/`Exit`/`Resize`. Raw PTY bytes NEVER ride NDJSON.
//!
//! P1 is pure types + framing — there are no sockets, spawning, or I/O loops
//! here yet; those land in later phases (client/supervisor/daemon bin).

pub mod framing;
pub mod protocol;

pub use framing::{
    seq_is_monotonic, ExitStatus, FrameError, SeqTracker, StreamDecoder, StreamFrame,
    StreamFrameKind, MAX_SESSION_ID_BYTES, MAX_STREAM_FRAME_PAYLOAD, STREAM_FRAME_HEADER_BYTES,
    STREAM_FRAME_MAGIC,
};
pub use protocol::{
    daemon_bin_path, daemon_log_path, daemon_pid_path, daemon_socket_path, daemon_token_path,
    decode_ndjson_line, encode_ndjson_line, history_root, parse_pid_file, serialize_pid_file,
    write_secret_file, ClientKind, ControlMessage, DaemonPidFile, DaemonSocket, Hello, HelloAck,
    Notify, ProtocolError, RpcError, RpcReply, RpcRequest, GROVE_DAEMON_PROTOCOL_VERSION,
    MAX_CONTROL_LINE_BYTES,
};
