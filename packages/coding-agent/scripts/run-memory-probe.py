#!/usr/bin/env python3
"""Run a synthetic memory probe under an external Darwin footprint cap."""
from __future__ import annotations

import argparse
import ctypes
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from dataclasses import asdict, dataclass

DEFAULT_LIMIT_BYTES = 2_000_000_000
COOPERATIVE_LIMIT_BYTES = 1_200_000_000
DEFAULT_INTERVAL_SECONDS = 0.05
DEFAULT_DEADLINE_SECONDS = 60.0
MAX_TRACE_BYTES = 512 * 1024
MAX_TRACE_LINE_BYTES = 4 * 1024
MAX_TRACE_ROWS = 4_096


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
    "payloadPlacement",
    "gcMode",
    "fixtureBytes",
    "sourceBytes",
    "transcriptEntries",
    "branchEntries",
    "retainedEntries",
    "contextMessages",
    "mountedComponents",
    "pendingTools",
    "wireBytes",
    "largestWriteBytes",
    "pendingOutputBytes",
    "frames",
    "acknowledgements",
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
    "contextMessages",
    "mountedComponents",
    "pendingTools",
    "wireBytes",
    "largestWriteBytes",
    "pendingOutputBytes",
    "frames",
    "acknowledgements",
    "stagedDisposals",
    "jscHeapSize",
    "jscExtraMemorySize",
    "jscObjectCount",
    "jscProtectedObjectCount",
}


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
            if not isinstance(row, dict) or not (valid_task_row(row) or valid_session_row(row)):
                dropped += 1
                continue
            rows.append(row)
    return rows, dropped


def clean_environment(home: Path, metrics_path: Path, stop_file: Path) -> dict[str, str]:
    required = ("PATH", "LANG", "LC_CTYPE", "TMPDIR", "SYSTEMROOT", "ComSpec")
    env = {key: value for key in required if (value := os.environ.get(key))}
    env["HOME"] = str(home)
    env["PI_CODING_AGENT_DIR"] = str(home / "agent")
    env["CI"] = "1"
    env["NO_COLOR"] = "1"
    env["OMP_TASK_LAUNCH_MEMORY_PROBE"] = "1"
    env["OMP_SESSION_RETENTION_MEMORY_PROBE"] = "1"
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
    parser.add_argument("--probe", type=Path, default=Path(__file__).resolve().parents[1] / "test" / "task-launch-memory-probe.ts")
    parser.add_argument("--bun", type=Path)
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


def main() -> int:
    args = parse_args()
    probe = args.probe.resolve()
    repo_root = args.repo_root.resolve()
    bun = args.bun or Path(shutil.which("bun") or "")
    if not probe.is_file():
        raise SystemExit(f"probe missing: {probe}")
    if not repo_root.is_dir():
        raise SystemExit(f"repository missing: {repo_root}")
    if not bun.is_file():
        raise SystemExit("bun executable not found")

    args.report.parent.mkdir(parents=True, exist_ok=True)
    started = time.time()
    with tempfile.TemporaryDirectory(prefix="omp-memory-probe-home-") as home_text, tempfile.TemporaryDirectory(
        prefix="omp-memory-probe-output-"
    ) as output_text:
        home = Path(home_text)
        output = Path(output_text)
        stdout_path = output / "stdout.txt"
        stderr_path = output / "stderr.txt"
        metrics_path = output / "metrics.jsonl"
        stop_file = home / "cooperative-stop"
        command = [str(bun), str(probe), *args.probe_args]
        with stdout_path.open("wb") as stdout, stderr_path.open("wb") as stderr:
            child = subprocess.Popen(
                command,
                cwd=repo_root,
                env=clean_environment(home, metrics_path, stop_file),
                stdin=subprocess.DEVNULL,
                stdout=stdout,
                stderr=stderr,
                start_new_session=True,
            )
            expected_group = child.pid
            initial: Usage | None = None
            for _ in range(20):
                initial = read_usage(child.pid)
                if initial is not None:
                    break
                if child.poll() is not None:
                    break
                time.sleep(0.01)
            if initial is None:
                child.wait(timeout=5)
                trace_path = metrics_path if metrics_path.exists() and metrics_path.stat().st_size > 0 else stdout_path
                rows, dropped = probe_trace(trace_path)
                report = {
                    "schemaVersion": 1,
                    "outcome": "startup_unreadable",
                    "pid": child.pid,
                    "limitBytes": args.limit_bytes,
                    "cooperativeLimitBytes": args.cooperative_limit_bytes,
                    "cooperativeStopRequested": stop_file.exists(),
                    "intervalMs": args.interval_ms,
                    "deadlineSeconds": args.deadline_seconds,
                    "probeRows": rows,
                    "probeRowsDropped": dropped,
                    "probeMetricsBytes": metrics_path.stat().st_size if metrics_path.exists() else 0,
                    "probeStdoutBytes": stdout_path.stat().st_size,
                    "probeStderrBytes": stderr_path.stat().st_size,
                }
                args.report.write_text(json.dumps(report, separators=(",", ":")) + "\n")
                return 1

            peak_footprint = initial.physical_footprint
            peak_lifetime = initial.lifetime_max_physical_footprint
            peak_resident = initial.resident
            samples: list[Sample] = []
            outcome = "exited"
            killed = False
            cooperative_stop_requested = False
            while True:
                now = time.time()
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
                time.sleep(args.interval_ms / 1000)

            try:
                return_code = child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                if kill_owned_group(child.pid, initial.start, expected_group):
                    outcome = "deadline_killed"
                return_code = child.wait(timeout=5)
        trace_path = metrics_path if metrics_path.exists() and metrics_path.stat().st_size > 0 else stdout_path
        rows, dropped = probe_trace(trace_path)
        report = {
            "schemaVersion": 1,
            "outcome": outcome,
            "pid": child.pid,
            "start": initial.start,
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
            "probeRows": rows,
            "probeRowsDropped": dropped,
            "probeMetricsBytes": metrics_path.stat().st_size if metrics_path.exists() else 0,
            "probeStdoutBytes": stdout_path.stat().st_size,
            "probeStderrBytes": stderr_path.stat().st_size,
        }
        args.report.write_text(json.dumps(report, separators=(",", ":")) + "\n")

    return 0 if outcome == "exited" else 2


if __name__ == "__main__":
    sys.exit(main())
