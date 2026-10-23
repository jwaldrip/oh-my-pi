#!/usr/bin/env python3
"""Run a synthetic memory probe under an external Darwin footprint cap."""
from __future__ import annotations

import argparse
import ctypes
import errno
import fcntl
import json
import hashlib
import os
from pathlib import Path
import pty
import re
import select
import selectors
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
from dataclasses import asdict, dataclass

DEFAULT_LIMIT_BYTES = 2_000_000_000
COOPERATIVE_LIMIT_BYTES = 1_200_000_000
DEFAULT_INTERVAL_SECONDS = 0.05
DEFAULT_DEADLINE_SECONDS = 60.0
MAX_TRACE_BYTES = 512 * 1024
MAX_TRACE_LINE_BYTES = 4 * 1024
MAX_TRACE_ROWS = 4_096

PTY_COLUMNS = 120
PTY_ROWS = 40
MAX_TSP_FRAGMENT_BYTES = 128 * 1024
MAX_TSP_PENDING_TAIL_BYTES = 256
TSP_PREFIX = b"\x1b_tsp;"
TSP_TERMINATOR = b"\x1b\\"
TSP_PARAM = re.compile(rb"^[A-Za-z0-9_-]+=[\x21-\x3a\x3c-\x7e]*$")


class RusageInfoV4(ctypes.Structure):
    _fields_ = [
        ("uuid", ctypes.c_uint8 * 16),
        ("user_time", ctypes.c_uint64),
        ("system_time", ctypes.c_uint64),
        ("pkg_idle_wkups", ctypes.c_uint64),
        ("interrupt_wkups", ctypes.c_uint64),
        ("pageins", ctypes.c_uint64),
        ("wired_size", ctypes.c_uint64),
        ("resident_size", ctypes.c_uint64),
        ("phys_footprint", ctypes.c_uint64),
        ("proc_start_abstime", ctypes.c_uint64),
        ("proc_exit_abstime", ctypes.c_uint64),
        ("child_user_time", ctypes.c_uint64),
        ("child_system_time", ctypes.c_uint64),
        ("child_pkg_idle_wkups", ctypes.c_uint64),
        ("child_interrupt_wkups", ctypes.c_uint64),
        ("child_pageins", ctypes.c_uint64),
        ("child_elapsed_abstime", ctypes.c_uint64),
        ("diskio_bytesread", ctypes.c_uint64),
        ("diskio_byteswritten", ctypes.c_uint64),
        ("cpu_time_qos_default", ctypes.c_uint64),
        ("cpu_time_qos_maintenance", ctypes.c_uint64),
        ("cpu_time_qos_background", ctypes.c_uint64),
        ("cpu_time_qos_utility", ctypes.c_uint64),
        ("cpu_time_qos_legacy", ctypes.c_uint64),
        ("cpu_time_qos_user_initiated", ctypes.c_uint64),
        ("cpu_time_qos_user_interactive", ctypes.c_uint64),
        ("billed_system_time", ctypes.c_uint64),
        ("serviced_system_time", ctypes.c_uint64),
        ("logical_writes", ctypes.c_uint64),
        ("lifetime_max_phys_footprint", ctypes.c_uint64),
        ("instructions", ctypes.c_uint64),
        ("cycles", ctypes.c_uint64),
        ("billed_energy", ctypes.c_uint64),
        ("serviced_energy", ctypes.c_uint64),
        ("interval_max_phys_footprint", ctypes.c_uint64),
        ("runnable_time", ctypes.c_uint64),
    ]


assert ctypes.sizeof(RusageInfoV4) == 296
assert RusageInfoV4.phys_footprint.offset == 72

_LIBPROC = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
_LIBPROC.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
_LIBPROC.proc_pid_rusage.restype = ctypes.c_int


@dataclass(frozen=True)
class Usage:
    physical_footprint: int
    lifetime_max_physical_footprint: int
    resident: int
    start: int


@dataclass(frozen=True)
class Sample:
    elapsed_ms: int
    physical_footprint: int
    lifetime_max_physical_footprint: int
    resident: int


def read_usage(pid: int) -> Usage | None:
    usage = RusageInfoV4()
    if _LIBPROC.proc_pid_rusage(pid, 4, ctypes.byref(usage)) != 0:
        return None
    if usage.proc_exit_abstime != 0:
        return None
    return Usage(
        physical_footprint=int(usage.phys_footprint),
        lifetime_max_physical_footprint=int(usage.lifetime_max_phys_footprint),
        resident=int(usage.resident_size),
        start=int(usage.proc_start_abstime),
    )


def owned_process_group(pid: int, expected_start: int, expected_group: int) -> Usage | None:
    current = read_usage(pid)
    if current is None or current.start != expected_start:
        return None
    try:
        group = os.getpgid(pid)
    except ProcessLookupError:
        return None
    return current if group == expected_group else None


def kill_owned_group(pid: int, expected_start: int, expected_group: int) -> bool:
    if owned_process_group(pid, expected_start, expected_group) is None:
        return False
    try:
        os.killpg(expected_group, signal.SIGSTOP)
    except ProcessLookupError:
        return False
    if owned_process_group(pid, expected_start, expected_group) is None:
        return False
    try:
        os.killpg(expected_group, signal.SIGKILL)
    except ProcessLookupError:
        return False
    return True


TASK_TRACE_FIELDS = {
    "timestamp",
    "pid",
    "phase",
    "invocationId",
    "nativeTag",
    "heapUsed",
    "heapTotal",
    "external",
    "arrayBuffers",
    "bytesConsumed",
    "recordsVisited",
    "resultCount",
}
TASK_INTEGER_FIELDS = {
    "timestamp",
    "pid",
    "heapUsed",
    "heapTotal",
    "external",
    "arrayBuffers",
    "bytesConsumed",
    "recordsVisited",
    "resultCount",
}
SESSION_TRACE_FIELDS = {
    "timestamp",
    "pid",
    "cycle",
    "stage",
    "scenario",
    "payloadPlacement",
    "gcMode",
    "fixtureBytes",
    "sourceBytes",
    "transcriptEntries",
    "branchEntries",
    "retainedEntries",
    "sessionEntries",
    "contextMessages",
    "mountedComponents",
    "pendingTools",
    "modeConstructs",
    "modeStops",
    "tuiStops",
    "updatesApplied",
    "latestSentinelObserved",
    "reconcilerComponentStates",
    "reconcilerIdStates",
    "retainedDescriptions",
    "ttyWriterConstructed",
    "wireBytes",
    "largestWriteBytes",
    "pendingOutputBytes",
    "frames",
    "acknowledgements",
    "framesSent",
    "framesAcknowledged",
    "unackedFrames",
    "stagedDisposals",
    "jscHeapSize",
    "jscExtraMemorySize",
    "jscObjectCount",
    "jscProtectedObjectCount",
    "bunVersion",
    "bunRevision",
    "nativeAddonPath",
    "nativeAddonVersion",
    "nativeAddonChecksum",
    "nativeAddonBytes",
}
SESSION_INTEGER_FIELDS = {
    "timestamp",
    "pid",
    "cycle",
    "fixtureBytes",
    "sourceBytes",
    "transcriptEntries",
    "branchEntries",
    "retainedEntries",
    "sessionEntries",
    "contextMessages",
    "mountedComponents",
    "pendingTools",
    "modeConstructs",
    "modeStops",
    "tuiStops",
    "updatesApplied",
    "latestSentinelObserved",
    "reconcilerComponentStates",
    "reconcilerIdStates",
    "retainedDescriptions",
    "wireBytes",
    "largestWriteBytes",
    "pendingOutputBytes",
    "frames",
    "acknowledgements",
    "framesSent",
    "framesAcknowledged",
    "unackedFrames",
    "stagedDisposals",
    "jscHeapSize",
    "jscExtraMemorySize",
    "jscObjectCount",
    "jscProtectedObjectCount",
}

INCIDENT_TRACE_FIELDS = {
    "kind",
    "timestamp",
    "pid",
    "arm",
    "stage",
    "collection",
    "fixtureChecksum",
    "fixtureBytes",
    "fixtureEntries",
    "fixtureLinkedTailId",
    "restoredEntries",
    "agentMessageCount",
    "managerMessagePayloadBytes",
    "agentMessagePayloadBytes",
    "sharedManagerAgentMessageCount",
    "builtinToolCount",
    "enabledToolCount",
    "ruleCount",
    "contextFileCount",
    "promptBytes",
    "requestPreparationPhase",
    "requestPreparationSourceMessages",
    "requestPreparationConvertedMessages",
    "requestPreparationProviderMessages",
    "requestPreparationToolCount",
    "requestPreparationSerializedCodeUnits",
    "requestCount",
    "requestBytes",
    "providerDeltaBytes",
    "cumulativeArgumentBytes",
    "serializedTurns",
    "verifiedWriteCount",
    "finalResultCount",
    "replacementResultsObserved",
    "queueOutstandingEvents",
    "queueOutstandingPayloadBytes",
    "queueHighWaterEvents",
    "queueHighWaterPayloadBytes",
    "queueEnqueuedEvents",
    "queueDequeuedEvents",
    "revealEntryCount",
    "revealTargetBytes",
    "revealPrefixBytes",
    "revealParsedArgumentBytes",
    "revealDisplayArgumentBytes",
    "toolArgumentBytes",
    "toolResultTextBytes",
    "toolDetailsBytes",
    "toolImageBytes",
    "modeConstructs",
    "modeStops",
    "tuiStops",
    "nativeComponentStates",
    "nativeIdStates",
    "nativeFramesSent",
    "nativeFramesAcknowledged",
    "nativeUnackedFrames",
    "nativePendingBlobCount",
    "nativePendingBlobBytes",
    "nativePendingOutputBytes",
    "terminalWireBytes",
    "terminalLargestWriteBytes",
    "heapUsed",
    "heapTotal",
    "external",
    "arrayBuffers",
    "rss",
    "diagnosticHeapSize",
    "diagnosticExtraMemorySize",
    "diagnosticObjectCount",
    "diagnosticProtectedObjectCount",
}
INCIDENT_INTEGER_FIELDS = INCIDENT_TRACE_FIELDS - {
    "kind",
    "arm",
    "stage",
    "collection",
    "requestPreparationPhase",
    "fixtureChecksum",
    "fixtureLinkedTailId",
}


def valid_incident_row(row: dict[str, object]) -> bool:
    if set(row) != INCIDENT_TRACE_FIELDS:
        return False
    if row["kind"] != "incident-memory-attribution":
        return False
    if row["arm"] not in {"engine-only", "native"}:
        return False
    if row["collection"] not in {"passive", "heapStats", "gc"}:
        return False
    if any(not is_nonnegative_integer(row[field]) for field in INCIDENT_INTEGER_FIELDS):
        return False
    if not is_bounded_string(row["stage"], 128):
        return False
    if not is_bounded_string(row["requestPreparationPhase"], 128):
        return False
    if not is_bounded_string(row["fixtureLinkedTailId"], 128):
        return False
    checksum = row["fixtureChecksum"]
    return (
        isinstance(checksum, str)
        and len(checksum) == 64
        and all(char in "0123456789abcdef" for char in checksum)
    )


def is_nonnegative_integer(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def is_bounded_string(value: object, limit: int) -> bool:
    return isinstance(value, str) and len(value) <= limit


def valid_task_row(row: dict[str, object]) -> bool:
    if set(row) != TASK_TRACE_FIELDS:
        return False
    if any(not is_nonnegative_integer(row[field]) for field in TASK_INTEGER_FIELDS):
        return False
    if not is_bounded_string(row["phase"], 128) or not is_bounded_string(row["invocationId"], 128):
        return False
    return row["nativeTag"] is None or is_bounded_string(row["nativeTag"], 128)


def valid_session_row(row: dict[str, object]) -> bool:
    if set(row) != SESSION_TRACE_FIELDS:
        return False
    if any(not is_nonnegative_integer(row[field]) for field in SESSION_INTEGER_FIELDS):
        return False
    if not is_bounded_string(row["stage"], 128):
        return False
    if row["payloadPlacement"] not in {"message", "custom", "tool-result"}:
        return False
    if row["gcMode"] not in {"natural", "diagnostic"}:
        return False
    if row["scenario"] not in {"teardown", "live-tool-result"}:
        return False
    if not isinstance(row["ttyWriterConstructed"], bool):
        return False
    if row["nativeAddonBytes"] is not None and not is_nonnegative_integer(row["nativeAddonBytes"]):
        return False
    for field, limit in (
        ("bunVersion", 128),
        ("bunRevision", 128),
        ("nativeAddonPath", 1024),
        ("nativeAddonVersion", 128),
        ("nativeAddonChecksum", 64),
    ):
        value = row[field]
        if value is not None and not is_bounded_string(value, limit):
            return False
    checksum = row["nativeAddonChecksum"]
    return checksum is None or all(char in "0123456789abcdef" for char in checksum)


def probe_trace(path: Path) -> tuple[list[dict[str, object]], int]:
    rows: list[dict[str, object]] = []
    dropped = 0
    seen_bytes = 0
    with path.open("rb") as stream:
        for line in stream:
            seen_bytes += len(line)
            if seen_bytes > MAX_TRACE_BYTES or len(rows) >= MAX_TRACE_ROWS or len(line) > MAX_TRACE_LINE_BYTES:
                dropped += 1
                continue
            try:
                row = json.loads(line)
            except (TypeError, ValueError):
                dropped += 1
                continue
            if not isinstance(row, dict) or not (valid_task_row(row) or valid_session_row(row) or valid_incident_row(row)):
                dropped += 1
                continue
            rows.append(row)
    return rows, dropped

def probe_option(probe_args: list[str], name: str, default: int) -> int:
    for index, value in enumerate(probe_args):
        if value == name and index + 1 < len(probe_args):
            return int(probe_args[index + 1])
        if value.startswith(f"{name}="):
            return int(value.split("=", 1)[1])
    return default


def probe_scenario(probe_args: list[str]) -> str | None:
    for index, value in enumerate(probe_args):
        if value == "--scenario" and index + 1 < len(probe_args):
            return probe_args[index + 1]
        if value.startswith("--scenario="):
            return value.split("=", 1)[1]
    return None

def probe_string_option(probe_args: list[str], name: str) -> str | None:
    for index, value in enumerate(probe_args):
        if value == name and index + 1 < len(probe_args):
            return probe_args[index + 1]
        if value.startswith(f"{name}="):
            return value.split("=", 1)[1]
    return None


def expected_live_sentinel(probe_args: list[str]) -> str | None:
    if probe_scenario(probe_args) != "live-tool-result":
        return None
    return f"live-tool-result:{probe_option(probe_args, '--cycles', 8)}:{probe_option(probe_args, '--updates-per-cycle', 32)}"


def expected_incident_sentinel(probe_args: list[str]) -> str | None:
    return "incident-memory:complete" if probe_scenario(probe_args) == "incident-memory-attribution" else None


class PtyTspTransport:
    """Bounded TSP peer: acknowledges logical frames without retaining their bodies."""

    def __init__(self, master: int, expected_sentinel: str | None):
        self.master = master
        self.expected_sentinel = expected_sentinel.encode() if expected_sentinel else None
        self.buffer = bytearray()
        self.pending_chunk: str | None = None
        self.pending_frame: tuple[str, int] | None = None
        self.sentinel_tail = b""
        self.hello_seen = False
        self.frames_sent = 0
        self.frames_acknowledged = 0
        self.tsp_fragments = 0
        self.wire_bytes = 0
        self.latest_sentinel_observed = False
        self.protocol_error: str | None = None
        self.last_acknowledged: dict[str, int] = {}

    def _fail(self, message: str) -> None:
        if self.protocol_error is None:
            self.protocol_error = message

    def _write(self, data: bytes) -> None:
        view = memoryview(data)
        while view:
            try:
                written = os.write(self.master, view)
            except BlockingIOError:
                select.select([], [self.master], [], 0.05)
                continue
            if written <= 0:
                self._fail("PTY rejected a TSP reply")
                return
            view = view[written:]

    def _reply_hello(self) -> None:
        if self.hello_seen:
            return
        self.hello_seen = True
        reply = {
            "r": "hello",
            "v": 1,
            "term": "memory-probe",
            "kinds": [
                "col",
                "row",
                "card",
                "section",
                "rule",
                "spacer",
                "text",
                "md",
                "code",
                "diff",
                "ansi",
                "math",
                "image",
                "media",
                "kv",
                "table",
                "tree",
                "badge",
                "kbd",
                "icon",
                "spinner",
                "shimmer",
                "elapsed",
                "progress",
                "rate",
                "list",
                "item",
                "tabs",
                "editor",
                "input",
                "status",
                "seg",
                "overlay",
                "toast",
                "rows",
                "picker",
                "prefs",
                "tool",
                "checklist",
                "agent",
                "chart",
                "meter",
                "effort",
            ],
            "features": ["settle"],
            "apc": 1024,
            "credits": 1,
            "cols": PTY_COLUMNS,
            "dark": True,
        }
        body = json.dumps(reply, separators=(",", ":")).encode()
        self._write(TSP_PREFIX + b"r;" + body + TSP_TERMINATOR)

    def _acknowledge(self, frame: tuple[str, int] | None) -> None:
        if frame is None:
            self._fail("TSP frame completed without surface/sequence identifiers")
            return
        surface, sequence = frame
        if sequence <= self.last_acknowledged.get(surface, 0):
            return
        body = json.dumps({"ev": "ack", "sf": surface, "s": sequence}, separators=(",", ":")).encode()
        self._write(TSP_PREFIX + b"e;" + body + TSP_TERMINATOR)
        self.last_acknowledged[surface] = sequence
        self.frames_acknowledged += 1

    @staticmethod
    def _frame_identifier(body: bytes) -> tuple[str, int] | None:
        match = re.search(rb'"sf":"([^"\\]+)","s":(\d+)', body[:MAX_TSP_PENDING_TAIL_BYTES])
        if match is None:
            return None
        return match.group(1).decode("utf-8"), int(match.group(2))

    def _scan_sentinel(self, body: bytes) -> None:
        if self.expected_sentinel is None or self.latest_sentinel_observed:
            return
        candidate = self.sentinel_tail + body
        if self.expected_sentinel in candidate:
            self.latest_sentinel_observed = True
        self.sentinel_tail = candidate[-MAX_TSP_PENDING_TAIL_BYTES:]

    def _handle_message(self, raw: bytes) -> None:
        inner = raw[len(TSP_PREFIX) : -len(TSP_TERMINATOR)]
        separator = inner.find(b";")
        if separator <= 0:
            self._fail("malformed TSP message")
            return
        verb = inner[:separator]
        parts = inner[separator + 1 :].split(b";")
        params: dict[str, str] = {}
        body = b""
        for index, part in enumerate(parts):
            if TSP_PARAM.fullmatch(part):
                key, value = part.split(b"=", 1)
                params[key.decode("ascii")] = value.decode("ascii")
                continue
            body = b";".join(parts[index:])
            break
        self.tsp_fragments += 1
        if verb == b"q":
            if b'"q":"hello"' in body:
                self._reply_hello()
            return
        if verb != b"f":
            return
        self._scan_sentinel(body)
        chunk_id = params.get("c")
        more = params.get("m") == "1"
        if chunk_id is None:
            if more:
                self._fail("TSP frame marked continued without a chunk identifier")
                return
            self.frames_sent += 1
            self._acknowledge(self._frame_identifier(body))
            return
        if self.pending_chunk is None:
            self.pending_chunk = chunk_id
            self.pending_frame = self._frame_identifier(body)
            if self.pending_frame is None:
                self._fail("first TSP frame chunk lacked surface/sequence identifiers")
                return
        elif chunk_id != self.pending_chunk:
            self._fail("interleaved TSP frame chunks")
            return
        if more:
            return
        self.frames_sent += 1
        self._acknowledge(self.pending_frame)
        self.pending_chunk = None
        self.pending_frame = None

    def _consume(self) -> None:
        while True:
            start = self.buffer.find(TSP_PREFIX)
            if start < 0:
                keep = min(len(self.buffer), len(TSP_PREFIX) - 1)
                if keep:
                    del self.buffer[:-keep]
                else:
                    self.buffer.clear()
                return
            if start:
                del self.buffer[:start]
            end = self.buffer.find(TSP_TERMINATOR, len(TSP_PREFIX))
            if end < 0:
                if len(self.buffer) > MAX_TSP_FRAGMENT_BYTES:
                    self._fail("TSP fragment exceeded bounded parser capacity")
                    self.buffer.clear()
                return
            end += len(TSP_TERMINATOR)
            if end > MAX_TSP_FRAGMENT_BYTES:
                self._fail("TSP fragment exceeded bounded parser capacity")
                del self.buffer[:end]
                continue
            raw = bytes(self.buffer[:end])
            del self.buffer[:end]
            self._handle_message(raw)

    def drain(self) -> None:
        while True:
            try:
                chunk = os.read(self.master, 16 * 1024)
            except BlockingIOError:
                return
            except OSError as error:
                if error.errno == errno.EIO:
                    return
                self._fail(f"PTY read failed: {error}")
                return
            if not chunk:
                return
            self.wire_bytes += len(chunk)
            self.buffer.extend(chunk)
            self._consume()

    def summary(self) -> dict[str, object]:
        return {
            "enabled": True,
            "columns": PTY_COLUMNS,
            "rows": PTY_ROWS,
            "helloSeen": self.hello_seen,
            "framesSent": self.frames_sent,
            "framesAcknowledged": self.frames_acknowledged,
            "unackedFrames": max(0, self.frames_sent - self.frames_acknowledged),
            "tspFragments": self.tsp_fragments,
            "wireBytes": self.wire_bytes,
            "latestSentinelObserved": self.latest_sentinel_observed,
            "protocolError": self.protocol_error,
        }


def clean_environment(home: Path, metrics_path: Path, stop_file: Path) -> dict[str, str]:
    required = ("PATH", "LANG", "LC_CTYPE", "TMPDIR", "SYSTEMROOT", "ComSpec")
    env = {key: value for key in required if (value := os.environ.get(key))}
    env["HOME"] = str(home)
    env["PI_CODING_AGENT_DIR"] = str(home / "agent")
    env["CI"] = "1"
    env["NO_COLOR"] = "1"
    env["TERM"] = "xterm-256color"
    env["TERM_PROGRAM"] = "tern"
    env["COLUMNS"] = str(PTY_COLUMNS)
    env["LINES"] = str(PTY_ROWS)
    env["PI_TUI_NATIVE"] = "1"
    env["PI_NO_GLYPH_PROTOCOL"] = "1"
    env["OMP_TASK_LAUNCH_MEMORY_PROBE"] = "1"
    env["OMP_SESSION_RETENTION_MEMORY_PROBE"] = "1"
    env["OMP_INCIDENT_MEMORY_ATTRIBUTION_PROBE"] = "1"
    env["OMP_MEMORY_PROBE_METRICS_PATH"] = str(metrics_path)
    env["OMP_MEMORY_PROBE_STOP_FILE"] = str(stop_file)
    return env


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--limit-bytes", type=int, default=DEFAULT_LIMIT_BYTES)
    parser.add_argument("--cooperative-limit-bytes", type=int, default=COOPERATIVE_LIMIT_BYTES)
    parser.add_argument("--interval-ms", type=int, default=int(DEFAULT_INTERVAL_SECONDS * 1000))
    parser.add_argument("--deadline-seconds", type=float, default=DEFAULT_DEADLINE_SECONDS)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[3])
    launch = parser.add_mutually_exclusive_group()
    launch.add_argument(
        "--source-probe",
        "--probe",
        dest="source_probe",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "test" / "task-launch-memory-probe.ts",
    )
    launch.add_argument("--executable", type=Path)
    parser.add_argument("--bun", type=Path)
    parser.add_argument("--pty-tsp", action="store_true")
    parser.add_argument("--expect-sentinel")
    parser.add_argument("probe_args", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.probe_args[:1] == ["--"]:
        args.probe_args = args.probe_args[1:]
    if args.limit_bytes <= 0 or args.limit_bytes > DEFAULT_LIMIT_BYTES:
        parser.error(f"--limit-bytes must be between 1 and {DEFAULT_LIMIT_BYTES}")
    if args.cooperative_limit_bytes <= 0 or args.cooperative_limit_bytes >= args.limit_bytes:
        parser.error("--cooperative-limit-bytes must be positive and below --limit-bytes")
    if args.interval_ms != 50 and args.limit_bytes == DEFAULT_LIMIT_BYTES:
        parser.error("the production-cap probe requires --interval-ms 50")
    if args.deadline_seconds != DEFAULT_DEADLINE_SECONDS and args.limit_bytes == DEFAULT_LIMIT_BYTES:
        parser.error("the production-cap probe requires --deadline-seconds 60")
    if args.interval_ms <= 0 or args.deadline_seconds <= 0:
        parser.error("interval and deadline must be positive")
    return args


def file_checksum(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def stderr_summary(path: Path) -> str | None:
    if not path.exists() or path.stat().st_size == 0:
        return None
    with path.open("rb") as stream:
        text = stream.read(8192).decode("utf-8", "replace")
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    meaningful = [line for line in lines if "error" in line.lower() or "failed" in line.lower()]
    summary = meaningful[0] if meaningful else lines[0]
    return " ".join([summary, *lines[1:]])[:1024]



def main() -> int:
    args = parse_args()
    repo_root = args.repo_root.resolve()
    if not repo_root.is_dir():
        raise SystemExit(f"repository missing: {repo_root}")

    launch_mode: str
    launch_target: Path
    command: list[str]
    if args.executable is not None:
        launch_target = args.executable.resolve()
        if not launch_target.is_file() or not os.access(launch_target, os.X_OK):
            raise SystemExit(f"compiled executable missing or not executable: {launch_target}")
        launch_mode = "compiled"
        command = [str(launch_target), *args.probe_args]
    else:
        launch_target = args.source_probe.resolve()
        bun = args.bun or Path(shutil.which("bun") or "")
        if not launch_target.is_file():
            raise SystemExit(f"source probe missing: {launch_target}")
        if not bun.is_file():
            raise SystemExit("bun executable not found")
        launch_mode = "source"
        command = [str(bun), str(launch_target), *args.probe_args]

    args.report.parent.mkdir(parents=True, exist_ok=True)
    started = time.time()
    scenario = probe_scenario(args.probe_args)
    expected_sentinel = (
        args.expect_sentinel
        or expected_incident_sentinel(args.probe_args)
        or expected_live_sentinel(args.probe_args)
    )
    with tempfile.TemporaryDirectory(prefix="omp-memory-probe-home-") as home_text, tempfile.TemporaryDirectory(
        prefix="omp-memory-probe-output-"
    ) as output_text:
        home = Path(home_text)
        output = Path(output_text)
        stdout_path = output / "stdout.txt"
        stderr_path = output / "stderr.txt"
        metrics_path = output / "metrics.jsonl"
        stop_file = home / "cooperative-stop"
        environment = clean_environment(home, metrics_path, stop_file)
        transport: PtyTspTransport | None = None
        selector: selectors.BaseSelector | None = None
        master: int | None = None
        child: subprocess.Popen[bytes]
        try:
            with stdout_path.open("wb") as stdout, stderr_path.open("wb") as stderr:
                if args.pty_tsp:
                    master, slave = pty.openpty()
                    winsize = struct.pack("HHHH", PTY_ROWS, PTY_COLUMNS, 0, 0)
                    fcntl.ioctl(master, termios.TIOCSWINSZ, winsize)
                    fcntl.ioctl(slave, termios.TIOCSWINSZ, winsize)

                    def attach_private_tty() -> None:
                        os.setsid()
                        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

                    try:
                        child = subprocess.Popen(
                            command,
                            cwd=repo_root,
                            env=environment,
                            stdin=slave,
                            stdout=slave,
                            stderr=stderr,
                            preexec_fn=attach_private_tty,
                        )
                    finally:
                        os.close(slave)
                    os.set_blocking(master, False)
                    selector = selectors.DefaultSelector()
                    selector.register(master, selectors.EVENT_READ)
                    transport = PtyTspTransport(master, expected_sentinel)
                else:
                    child = subprocess.Popen(
                        command,
                        cwd=repo_root,
                        env=environment,
                        stdin=subprocess.DEVNULL,
                        stdout=stdout,
                        stderr=stderr,
                        start_new_session=True,
                    )

                expected_group = child.pid
                initial: Usage | None = None
                for _ in range(20):
                    if transport is not None:
                        for _key, _mask in selector.select(timeout=0):
                            transport.drain()
                    initial = read_usage(child.pid)
                    if initial is not None:
                        break
                    if child.poll() is not None:
                        break
                    time.sleep(0.01)

                samples: list[Sample] = []
                outcome = "exited"
                killed = False
                cooperative_stop_requested = False
                return_code: int | None = None
                peak_footprint = 0
                peak_lifetime = 0
                peak_resident = 0

                if initial is None:
                    try:
                        return_code = child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        return_code = child.kill() or child.wait(timeout=5)
                    outcome = "startup_unreadable"
                else:
                    peak_footprint = initial.physical_footprint
                    peak_lifetime = initial.lifetime_max_physical_footprint
                    peak_resident = initial.resident
                    next_sample = time.monotonic()
                    while True:
                        if transport is not None:
                            timeout = max(0.0, min(args.interval_ms / 1000, next_sample - time.monotonic()))
                            for _key, _mask in selector.select(timeout=timeout):
                                transport.drain()
                        else:
                            sleep_seconds = max(0.0, next_sample - time.monotonic())
                            if sleep_seconds:
                                time.sleep(sleep_seconds)
                        if time.monotonic() < next_sample:
                            continue
                        now = time.time()
                        next_sample += args.interval_ms / 1000
                        current = read_usage(child.pid)
                        if current is not None:
                            peak_footprint = max(peak_footprint, current.physical_footprint)
                            peak_lifetime = max(peak_lifetime, current.lifetime_max_physical_footprint)
                            peak_resident = max(peak_resident, current.resident)
                            if len(samples) < 1_200:
                                samples.append(
                                    Sample(
                                        elapsed_ms=round((now - started) * 1000),
                                        physical_footprint=current.physical_footprint,
                                        lifetime_max_physical_footprint=current.lifetime_max_physical_footprint,
                                        resident=current.resident,
                                    )
                                )
                            if current.start != initial.start:
                                outcome = "identity_changed"
                                break
                            if current.physical_footprint >= args.cooperative_limit_bytes and not cooperative_stop_requested:
                                stop_file.write_text("stop\n")
                                cooperative_stop_requested = True
                            if current.physical_footprint >= args.limit_bytes:
                                killed = kill_owned_group(child.pid, initial.start, expected_group)
                                outcome = "limit_killed" if killed else "ownership_lost"
                                break
                        elif child.poll() is not None:
                            break
                        if now - started >= args.deadline_seconds:
                            killed = kill_owned_group(child.pid, initial.start, expected_group)
                            outcome = "deadline_killed" if killed else "ownership_lost"
                            break

                    try:
                        return_code = child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        if kill_owned_group(child.pid, initial.start, expected_group):
                            outcome = "deadline_killed"
                        return_code = child.wait(timeout=5)

                if transport is not None:
                    for _ in range(10):
                        for _key, _mask in selector.select(timeout=0.01):
                            transport.drain()
                        transport.drain()
        finally:
            if selector is not None:
                selector.close()
            if master is not None:
                os.close(master)

        trace_path = metrics_path if metrics_path.exists() and metrics_path.stat().st_size > 0 else stdout_path
        rows, dropped = probe_trace(trace_path)
        pty_summary = transport.summary() if transport is not None else None
        if outcome == "exited" and return_code != 0:
            outcome = "probe_failed"
        if outcome == "exited" and cooperative_stop_requested:
            outcome = "cooperative_stopped"
        if outcome == "exited" and dropped != 0:
            outcome = "trace_dropped"
        if outcome == "exited" and pty_summary is not None:
            pty_complete = (
                pty_summary["helloSeen"] is True
                and pty_summary["protocolError"] is None
                and pty_summary["framesSent"] == pty_summary["framesAcknowledged"]
                and pty_summary["unackedFrames"] == 0
                and (expected_sentinel is None or pty_summary["latestSentinelObserved"] is True)
            )
            if not pty_complete:
                outcome = "pty_protocol_incomplete"
        if outcome == "exited" and scenario == "live-tool-result":
            completed_rows = [
                row
                for row in rows
                if row.get("scenario") == "live-tool-result" and row.get("stage") == "live:complete"
            ]
            if not completed_rows:
                outcome = "live_probe_incomplete"
            else:
                final = completed_rows[-1]
                expected_updates = probe_option(args.probe_args, "--cycles", 8) * probe_option(
                    args.probe_args, "--updates-per-cycle", 32
                )
                if (
                    final["modeConstructs"] != 1
                    or final["modeStops"] != 0
                    or final["tuiStops"] != 0
                    or final["pendingTools"] != 0
                    or final["updatesApplied"] != expected_updates
                    or final["latestSentinelObserved"] != expected_updates
                    or final["unackedFrames"] != 0
                    or final["pendingOutputBytes"] != 0
                    or final["ttyWriterConstructed"] is not True
                ):
                    outcome = "live_probe_incomplete"
        if outcome == "exited" and scenario == "incident-memory-attribution":
            incident_rows = [row for row in rows if row.get("kind") == "incident-memory-attribution"]
            if len(incident_rows) != len(rows):
                outcome = "incident_trace_mixed"
            else:
                expected_arm = probe_string_option(args.probe_args, "--arm")
                completion_rows = [row for row in incident_rows if row.get("stage") == "incident:complete"]
                heap_stats_rows = [row for row in incident_rows if row.get("stage") == "incident:post-heap-stats"]
                gc_rows = [row for row in incident_rows if row.get("stage") == "incident:post-gc"]
                if len(completion_rows) != 1 or len(heap_stats_rows) != 1 or len(gc_rows) != 1:
                    outcome = "incident_probe_incomplete"
                else:
                    final = completion_rows[0]
                    common_complete = (
                        expected_arm in {"engine-only", "native"}
                        and final["arm"] == expected_arm
                        and final["collection"] == "passive"
                        and final["fixtureBytes"] == 167_772_160
                        and final["fixtureEntries"] == 26_800
                        and final["restoredEntries"] == 26_800
                        and final["agentMessageCount"] == 26_800
                        and final["serializedTurns"] == 4
                        and final["verifiedWriteCount"] == 4
                        and final["finalResultCount"] == 4
                        and final["replacementResultsObserved"] == 8
                        and final["queueOutstandingEvents"] == 0
                        and final["queueOutstandingPayloadBytes"] == 0
                    )
                    post_complete = (
                        heap_stats_rows[0]["collection"] == "heapStats"
                        and gc_rows[0]["collection"] == "gc"
                    )
                    native_complete = (
                        final["modeConstructs"] == 1
                        and final["modeStops"] == 0
                        and final["tuiStops"] == 0
                        and final["nativeUnackedFrames"] == 0
                        and final["nativePendingBlobBytes"] == 0
                        and final["nativePendingOutputBytes"] == 0
                    )
                    engine_complete = (
                        final["modeConstructs"] == 0
                        and final["modeStops"] == 0
                        and final["tuiStops"] == 0
                        and final["nativeComponentStates"] == 0
                        and final["nativeIdStates"] == 0
                        and final["nativeUnackedFrames"] == 0
                        and final["nativePendingBlobBytes"] == 0
                        and final["nativePendingOutputBytes"] == 0
                    )
                    if not common_complete or not post_complete or (
                        expected_arm == "native" and not native_complete
                    ) or (expected_arm == "engine-only" and not engine_complete):
                        outcome = "incident_probe_incomplete"
        report = {
            "schemaVersion": 2,
            "outcome": outcome,
            "launch": {
                "mode": launch_mode,
                "inputChecksum": file_checksum(launch_target),
                "ptyTsp": args.pty_tsp,
            },
            "pid": child.pid,
            "start": initial.start if initial is not None else None,
            "processGroup": expected_group,
            "limitBytes": args.limit_bytes,
            "cooperativeLimitBytes": args.cooperative_limit_bytes,
            "cooperativeStopRequested": cooperative_stop_requested,
            "intervalMs": args.interval_ms,
            "deadlineSeconds": args.deadline_seconds,
            "killed": killed,
            "returnCode": return_code,
            "peak": {
                "physicalFootprint": peak_footprint,
                "lifetimeMaxPhysicalFootprint": peak_lifetime,
                "resident": peak_resident,
            },
            "samples": [asdict(sample) for sample in samples],
            "pty": pty_summary,
            "expectedSentinel": expected_sentinel,
            "probeRows": rows,
            "probeRowsDropped": dropped,
            "probeMetricsBytes": metrics_path.stat().st_size if metrics_path.exists() else 0,
            "probeStdoutBytes": stdout_path.stat().st_size,
            "probeStderrBytes": stderr_path.stat().st_size,
            "stderrSummary": stderr_summary(stderr_path),
        }
        args.report.write_text(json.dumps(report, separators=(",", ":")) + "\n")

    return 0 if outcome == "exited" else 2


if __name__ == "__main__":
    sys.exit(main())
