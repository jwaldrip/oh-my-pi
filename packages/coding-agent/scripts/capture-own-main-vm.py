#!/usr/bin/env python3
"""Capture one bounded kernel-only VM trace from a verified, read-only target."""
from __future__ import annotations

import argparse
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import signal
import subprocess
import sys
import tempfile
import threading
import time
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass
from typing import Any

TARGET_CAP_BYTES = 2_000_000_000
SAMPLE_INTERVAL_SECONDS = 0.05
OVERALL_DEADLINE_SECONDS = 60.0
RECORDING_SECONDS = 10
MAX_LOG_BYTES = 1 * 1024 * 1024
MAX_TRACE_BUNDLE_BYTES = 512 * 1024 * 1024
MAX_TOC_BYTES = 2 * 1024 * 1024
MAX_EVENT_EXPORT_BYTES = 32 * 1024 * 1024
MAX_REGION_COUNT = 32_768
MAX_REGION_OUTPUT_BYTES = 8 * 1024 * 1024
MAX_FILTERED_EVENT_ROWS = 4_096
MAX_NATIVE_FRAMES_PER_EVENT = 64
MAX_NUMERIC_ARGS_PER_EVENT = 16
MAX_ERROR_EXCERPT_BYTES = 4_096
MAX_RESOLVED_XML_NODES_PER_ROW = 512
PROC_PIDREGIONINFO = 7


class CaptureIncomplete(RuntimeError):
    pass


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


class ProcRegionInfo(ctypes.Structure):
    _fields_ = [
        ("protection", ctypes.c_uint32),
        ("max_protection", ctypes.c_uint32),
        ("inheritance", ctypes.c_uint32),
        ("flags", ctypes.c_uint32),
        ("offset", ctypes.c_uint64),
        ("behavior", ctypes.c_uint32),
        ("user_wired_count", ctypes.c_uint32),
        ("user_tag", ctypes.c_uint32),
        ("pages_resident", ctypes.c_uint32),
        ("pages_shared_now_private", ctypes.c_uint32),
        ("pages_swapped_out", ctypes.c_uint32),
        ("pages_dirtied", ctypes.c_uint32),
        ("ref_count", ctypes.c_uint32),
        ("shadow_depth", ctypes.c_uint32),
        ("share_mode", ctypes.c_uint32),
        ("private_pages_resident", ctypes.c_uint32),
        ("shared_pages_resident", ctypes.c_uint32),
        ("object_id", ctypes.c_uint32),
        ("depth", ctypes.c_uint32),
        ("address", ctypes.c_uint64),
        ("size", ctypes.c_uint64),
    ]


assert ctypes.sizeof(RusageInfoV4) == 296
assert RusageInfoV4.phys_footprint.offset == 72
assert ctypes.sizeof(ProcRegionInfo) == 96

_LIBPROC = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
_LIBPROC.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
_LIBPROC.proc_pid_rusage.restype = ctypes.c_int
_LIBPROC.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
_LIBPROC.proc_pidinfo.restype = ctypes.c_int
_LIBPROC.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
_LIBPROC.proc_pidpath.restype = ctypes.c_int


@dataclass(frozen=True)
class ProcessUsage:
    start_abstime: int
    physical_footprint: int
    resident_size: int


@dataclass(frozen=True)
class TargetIdentity:
    pid: int
    start_abstime: int
    executable: str
    process_group: int
    physical_footprint: int
    resident_size: int


@dataclass
class OwnedProcess:
    name: str
    handle: subprocess.Popen[bytes]
    start_abstime: int
    process_group: int
    stdout_path: Path
    stderr_path: Path
    watched_paths: tuple[Path, ...]
    terminated_by_script: bool = False


@dataclass(frozen=True)
class FootprintSample:
    monotonic_ns: int
    physical_footprint: int
    resident_size: int


def read_usage(pid: int) -> ProcessUsage | None:
    usage = RusageInfoV4()
    if _LIBPROC.proc_pid_rusage(pid, 4, ctypes.byref(usage)) != 0 or usage.proc_exit_abstime != 0:
        return None
    return ProcessUsage(
        start_abstime=int(usage.proc_start_abstime),
        physical_footprint=int(usage.phys_footprint),
        resident_size=int(usage.resident_size),
    )


def process_path(pid: int) -> str | None:
    buffer = ctypes.create_string_buffer(4096)
    length = _LIBPROC.proc_pidpath(pid, buffer, ctypes.sizeof(buffer))
    if length <= 0:
        return None
    return os.path.realpath(os.fsdecode(buffer.value))


def read_target_identity(pid: int) -> TargetIdentity | None:
    usage = read_usage(pid)
    executable = process_path(pid)
    if usage is None or executable is None:
        return None
    try:
        process_group = os.getpgid(pid)
    except ProcessLookupError:
        return None
    return TargetIdentity(
        pid=pid,
        start_abstime=usage.start_abstime,
        executable=executable,
        process_group=process_group,
        physical_footprint=usage.physical_footprint,
        resident_size=usage.resident_size,
    )


def file_size(path: Path) -> int:
    try:
        return path.stat().st_size
    except FileNotFoundError:
        return 0


def directory_size(path: Path, limit: int) -> int:
    total = 0
    if not path.exists():
        return total
    stack = [path]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as entries:
                for entry in entries:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            stack.append(Path(entry.path))
                        elif entry.is_file(follow_symlinks=False):
                            total += entry.stat(follow_symlinks=False).st_size
                            if total > limit:
                                return total
                    except FileNotFoundError:
                        continue
        except FileNotFoundError:
            continue
    return total


def watched_size(paths: tuple[Path, ...], limit: int) -> int:
    total = 0
    for path in paths:
        total += directory_size(path, limit - total) if path.is_dir() else file_size(path)
        if total > limit:
            return total
    return total


def output_excerpt(path: Path) -> str:
    try:
        raw = path.read_bytes()[:MAX_ERROR_EXCERPT_BYTES]
    except FileNotFoundError:
        return ""
    return raw.decode("utf-8", "replace")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def parse_macho_uuid(path: str, deadline: float, target_group: int, output_dir: Path) -> str:
    process = start_owned(
        "dwarfdump",
        ["dwarfdump", "--uuid", path],
        output_dir,
        target_group,
        (),
    )
    wait_owned(process, deadline, target_group, ())
    if process.handle.returncode != 0:
        raise CaptureIncomplete(f"dwarfdump failed: {output_excerpt(process.stderr_path)}")
    match = re.search(r"UUID: ([0-9A-F-]+)", output_excerpt(process.stdout_path))
    if match is None:
        raise CaptureIncomplete("dwarfdump did not return an image UUID")
    return match.group(1)


def start_owned(
    name: str,
    command: list[str],
    output_dir: Path,
    target_group: int,
    watched_paths: tuple[Path, ...],
) -> OwnedProcess:
    stdout_path = output_dir / f"{name}.stdout"
    stderr_path = output_dir / f"{name}.stderr"
    stdout = stdout_path.open("wb")
    stderr = stderr_path.open("wb")
    try:
        handle = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=stdout,
            stderr=stderr,
            start_new_session=True,
        )
    finally:
        stdout.close()
        stderr.close()
    usage = None
    for _ in range(20):
        usage = read_usage(handle.pid)
        if usage is not None:
            break
        if handle.poll() is not None:
            break
        time.sleep(0.01)
    if usage is None:
        raise CaptureIncomplete(f"owned {name} process had no readable identity")
    try:
        process_group = os.getpgid(handle.pid)
    except ProcessLookupError as error:
        raise CaptureIncomplete(f"owned {name} process exited before group verification") from error
    if process_group == target_group:
        raise CaptureIncomplete(f"owned {name} group matched observed target group")
    return OwnedProcess(
        name=name,
        handle=handle,
        start_abstime=usage.start_abstime,
        process_group=process_group,
        stdout_path=stdout_path,
        stderr_path=stderr_path,
        watched_paths=watched_paths,
    )


def terminate_owned(process: OwnedProcess, target_group: int) -> bool:
    if process.handle.poll() is not None:
        return False
    current = read_usage(process.handle.pid)
    if current is None or current.start_abstime != process.start_abstime:
        return False
    try:
        group = os.getpgid(process.handle.pid)
    except ProcessLookupError:
        return False
    if group != process.process_group or group == target_group:
        return False
    try:
        os.killpg(group, signal.SIGTERM)
    except ProcessLookupError:
        return False
    try:
        process.handle.wait(timeout=1)
    except subprocess.TimeoutExpired:
        current = read_usage(process.handle.pid)
        try:
            group = os.getpgid(process.handle.pid)
        except ProcessLookupError:
            return True
        if current is None or current.start_abstime != process.start_abstime or group != process.process_group or group == target_group:
            return False
        try:
            os.killpg(group, signal.SIGKILL)
        except ProcessLookupError:
            return False
    process.terminated_by_script = True
    return True


def target_matches(identity: TargetIdentity | None, args: argparse.Namespace) -> bool:
    return (
        identity is not None
        and identity.pid == args.target_pid
        and identity.start_abstime == args.expected_start_abstime
        and identity.executable == args.expected_executable
    )


def process_receipt(process: OwnedProcess) -> dict[str, object]:
    return {
        "name": process.name,
        "pid": process.handle.pid,
        "startAbstime": process.start_abstime,
        "processGroup": process.process_group,
        "returnCode": process.handle.returncode,
        "terminatedByScript": process.terminated_by_script,
        "stdoutBytes": file_size(process.stdout_path),
        "stderrBytes": file_size(process.stderr_path),
        "stderrExcerpt": output_excerpt(process.stderr_path),
    }


class TargetSampler:
    def __init__(self, args: argparse.Namespace) -> None:
        self._args = args
        self._stop = threading.Event()
        self._identity_mismatch = threading.Event()
        self._samples: list[FootprintSample] = []
        self._thread = threading.Thread(target=self._run, name="omp-main-footprint-sampler", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=1)

    @property
    def identity_mismatch(self) -> bool:
        return self._identity_mismatch.is_set()

    @property
    def samples(self) -> list[FootprintSample]:
        return list(self._samples)

    def _run(self) -> None:
        while not self._stop.is_set():
            identity = read_target_identity(self._args.target_pid)
            if not target_matches(identity, self._args):
                self._identity_mismatch.set()
                return
            if len(self._samples) < int(OVERALL_DEADLINE_SECONDS / SAMPLE_INTERVAL_SECONDS) + 4:
                self._samples.append(
                    FootprintSample(
                        monotonic_ns=time.monotonic_ns(),
                        physical_footprint=identity.physical_footprint,
                        resident_size=identity.resident_size,
                    )
                )
            self._stop.wait(SAMPLE_INTERVAL_SECONDS)


def enforce_owned(
    processes: list[OwnedProcess],
    sampler: TargetSampler,
    deadline: float,
    target_group: int,
    output_limit: int = MAX_LOG_BYTES,
) -> None:
    if sampler.identity_mismatch:
        for process in processes:
            terminate_owned(process, target_group)
        raise CaptureIncomplete("observed target identity changed")
    if time.monotonic() >= deadline:
        for process in processes:
            terminate_owned(process, target_group)
        raise CaptureIncomplete("overall capture deadline elapsed")
    for process in processes:
        if process.handle.poll() is not None:
            continue
        usage = read_usage(process.handle.pid)
        if usage is None or usage.start_abstime != process.start_abstime:
            terminate_owned(process, target_group)
            raise CaptureIncomplete(f"owned {process.name} identity changed")
        if usage.physical_footprint >= TARGET_CAP_BYTES:
            terminate_owned(process, target_group)
            raise CaptureIncomplete(f"owned {process.name} exceeded the 2 GB cap")
        if file_size(process.stdout_path) > MAX_LOG_BYTES or file_size(process.stderr_path) > MAX_LOG_BYTES:
            terminate_owned(process, target_group)
            raise CaptureIncomplete(f"owned {process.name} log output exceeded its bound")
        if process.watched_paths and watched_size(process.watched_paths, output_limit) > output_limit:
            terminate_owned(process, target_group)
            raise CaptureIncomplete(f"owned {process.name} output exceeded its bound")


def wait_owned(
    process: OwnedProcess,
    deadline: float,
    target_group: int,
    sampler: TargetSampler | tuple[()] = (),
    output_limit: int = MAX_LOG_BYTES,
) -> None:
    sampler_instance = sampler if isinstance(sampler, TargetSampler) else None
    while process.handle.poll() is None:
        if sampler_instance is not None:
            enforce_owned([process], sampler_instance, deadline, target_group, output_limit)
        elif time.monotonic() >= deadline:
            terminate_owned(process, target_group)
            raise CaptureIncomplete(f"owned {process.name} exceeded the overall deadline")
        elif (usage := read_usage(process.handle.pid)) is None or usage.start_abstime != process.start_abstime:
            terminate_owned(process, target_group)
            raise CaptureIncomplete(f"owned {process.name} identity changed")
        elif usage.physical_footprint >= TARGET_CAP_BYTES:
            terminate_owned(process, target_group)
            raise CaptureIncomplete(f"owned {process.name} exceeded the 2 GB cap")
        elif file_size(process.stdout_path) > MAX_LOG_BYTES or file_size(process.stderr_path) > MAX_LOG_BYTES:
            terminate_owned(process, target_group)
            raise CaptureIncomplete(f"owned {process.name} log output exceeded its bound")
        elif process.watched_paths and watched_size(process.watched_paths, output_limit) > output_limit:
            terminate_owned(process, target_group)
            raise CaptureIncomplete(f"owned {process.name} output exceeded its bound")
        time.sleep(SAMPLE_INTERVAL_SECONDS)


def region_record(region: ProcRegionInfo) -> dict[str, int]:
    return {
        "address": int(region.address),
        "size": int(region.size),
        "protection": int(region.protection),
        "maxProtection": int(region.max_protection),
        "flags": int(region.flags),
        "userTag": int(region.user_tag),
        "shareMode": int(region.share_mode),
        "pagesResident": int(region.pages_resident),
        "pagesDirtied": int(region.pages_dirtied),
        "pagesSwappedOut": int(region.pages_swapped_out),
        "privatePagesResident": int(region.private_pages_resident),
        "sharedPagesResident": int(region.shared_pages_resident),
    }


def walk_regions(pid: int, deadline: float) -> dict[str, object]:
    regions: list[dict[str, int]] = []
    cursor = 0
    output_bytes = 0
    incomplete: str | None = None
    end_errno = 0
    end_reason = "unknown"
    started_ns = time.monotonic_ns()
    while len(regions) < MAX_REGION_COUNT:
        if time.monotonic() >= deadline:
            incomplete = "overall deadline elapsed during region walk"
            break
        info = ProcRegionInfo()
        ctypes.set_errno(0)
        result = _LIBPROC.proc_pidinfo(pid, PROC_PIDREGIONINFO, cursor, ctypes.byref(info), ctypes.sizeof(info))
        error = ctypes.get_errno()
        if result == 0:
            end_errno = error
            # macOS returns EINVAL after a successfully advancing walk reaches
            # the end of this task's address space. It is not accepted before
            # a first region or after a non-progressing cursor.
            if error == errno.EINVAL and regions and cursor > 0:
                end_reason = "end-of-address-space"
                break
            incomplete = f"proc_pidinfo errno {error}"
            end_reason = "error"
            break
        if result != ctypes.sizeof(info):
            incomplete = f"proc_pidinfo returned {result} bytes"
            break
        if info.size == 0 or info.address < cursor or info.address + info.size <= info.address:
            incomplete = "nonprogress region response"
            break
        record = region_record(info)
        encoded_bytes = len(json.dumps(record, separators=(",", ":"))) + 1
        if output_bytes + encoded_bytes > MAX_REGION_OUTPUT_BYTES:
            incomplete = "region output bound exceeded"
            break
        output_bytes += encoded_bytes
        regions.append(record)
        cursor = int(info.address + info.size)
        if cursor > 0xFFFFFFFFFFFFFFFF:
            incomplete = "region address overflow"
            break
    else:
        incomplete = "region count bound exceeded"
    ended_ns = time.monotonic_ns()
    return {
        "startedMonotonicNs": started_ns,
        "endedMonotonicNs": ended_ns,
        "regionCount": len(regions),
        "endErrno": end_errno,
        "endReason": end_reason,
        "outputBytes": output_bytes,
        "incomplete": incomplete,
        "regions": regions,
    }


def diff_regions(before: dict[str, object], after: dict[str, object]) -> dict[str, object]:
    before_regions = {(region["address"], region["size"]): region for region in before["regions"]}  # type: ignore[index]
    after_regions = {(region["address"], region["size"]): region for region in after["regions"]}  # type: ignore[index]
    new = [after_regions[key] for key in after_regions.keys() - before_regions.keys()]
    removed = [before_regions[key] for key in before_regions.keys() - after_regions.keys()]
    changed: list[dict[str, int]] = []
    for key in before_regions.keys() & after_regions.keys():
        old = before_regions[key]
        current = after_regions[key]
        delta_resident = current["pagesResident"] - old["pagesResident"]
        delta_dirty = current["pagesDirtied"] - old["pagesDirtied"]
        delta_swapped = current["pagesSwappedOut"] - old["pagesSwappedOut"]
        if delta_resident or delta_dirty or delta_swapped:
            changed.append(
                {
                    "address": current["address"],
                    "size": current["size"],
                    "deltaPagesResident": delta_resident,
                    "deltaPagesDirtied": delta_dirty,
                    "deltaPagesSwappedOut": delta_swapped,
                    "userTag": current["userTag"],
                    "shareMode": current["shareMode"],
                }
            )
    changed.sort(key=lambda record: abs(record["deltaPagesResident"]) + abs(record["deltaPagesDirtied"]), reverse=True)
    return {
        "newMappingCount": len(new),
        "newMappingBytes": sum(region["size"] for region in new),
        "removedMappingCount": len(removed),
        "removedMappingBytes": sum(region["size"] for region in removed),
        "changedResidencyCount": len(changed),
        "changedResidency": changed[:MAX_FILTERED_EVENT_ROWS],
        "changedResidencyTruncated": len(changed) > MAX_FILTERED_EVENT_ROWS,
    }


def tag(element: ET.Element) -> str:
    return element.tag.rsplit("}", 1)[-1]


def integer_value(element: ET.Element | None) -> int | None:
    if element is None:
        return None
    text = (element.text or "").strip()
    if not text:
        text = element.attrib.get("fmt", "")
    try:
        return int(text, 0)
    except ValueError:
        return None


def dereference(element: ET.Element, by_id: dict[str, ET.Element]) -> ET.Element:
    seen: set[str] = set()
    current = element
    while "ref" in current.attrib:
        reference = current.attrib["ref"]
        if reference in seen:
            raise CaptureIncomplete("event export has a cyclic XML reference")
        if reference not in by_id:
            raise CaptureIncomplete("event export has an unresolved XML reference")
        seen.add(reference)
        current = by_id[reference]
    return current


def descendants(element: ET.Element, by_id: dict[str, ET.Element]) -> list[ET.Element]:
    result: list[ET.Element] = []
    seen_nodes: set[int] = set()
    stack = [element]
    while stack:
        current = dereference(stack.pop(), by_id)
        marker = id(current)
        if marker in seen_nodes:
            continue
        seen_nodes.add(marker)
        result.append(current)
        if len(result) > MAX_RESOLVED_XML_NODES_PER_ROW:
            raise CaptureIncomplete("event export exceeded the per-row XML traversal bound")
        stack.extend(reversed(list(current)))
    return result


def target_pid_for_row(row: ET.Element, by_id: dict[str, ET.Element]) -> int | None:
    for element in descendants(row, by_id):
        if tag(element) != "process":
            continue
        for candidate in descendants(element, by_id):
            if tag(candidate) == "pid":
                return integer_value(candidate)
    return None


def operation(schema: str, row: ET.Element, by_id: dict[str, ET.Element]) -> str:
    raw = ""
    for element in descendants(row, by_id):
        if tag(element) in {"syscall", "vm-op", "kdebug"}:
            raw = element.attrib.get("fmt", "") or (element.text or "")
            break
    normalized = raw.lower()
    if "mach_vm_allocate" in normalized:
        return "mach_vm_allocate"
    if "mach_vm_deallocate" in normalized:
        return "mach_vm_deallocate"
    if "mmap" in normalized and "munmap" not in normalized:
        return "mmap"
    if "munmap" in normalized:
        return "munmap"
    if schema == "virtual-memory" and "zero fill" in normalized:
        return "zero_fill"
    if schema == "virtual-memory" and "page cache hit" in normalized:
        return "page_cache_hit"
    if schema == "virtual-memory":
        return "other_vm_fault"
    if schema == "syscall":
        return "other_syscall"
    return "other_kdebug"


def native_frames(row: ET.Element, by_id: dict[str, ET.Element], expected_uuid: str) -> list[dict[str, int | str]]:
    frames: list[dict[str, int | str]] = []
    for element in descendants(row, by_id):
        if tag(element) != "frame":
            continue
        address = integer_value(ET.Element("address", {"fmt": element.attrib.get("addr", "")}))
        if address is None:
            continue
        binary: ET.Element | None = None
        for child in element:
            if tag(child) == "binary":
                binary = dereference(child, by_id)
                break
        if binary is None:
            continue
        uuid = binary.attrib.get("UUID", "").upper()
        if uuid != expected_uuid:
            continue
        load_address = integer_value(ET.Element("load", {"fmt": binary.attrib.get("load-addr", "")}))
        if load_address is None or address < load_address:
            continue
        frames.append(
            {
                "imageUuid": expected_uuid,
                "address": address,
                "loadAddress": load_address,
                "offset": address - load_address,
            }
        )
        if len(frames) >= MAX_NATIVE_FRAMES_PER_EVENT:
            break
    return frames


def numeric_fields(row: ET.Element, by_id: dict[str, ET.Element]) -> tuple[list[int], list[int], list[int]]:
    arguments: list[int] = []
    addresses: list[int] = []
    sizes: list[int] = []
    for element in descendants(row, by_id):
        name = tag(element)
        value = integer_value(element)
        if value is None:
            continue
        if name in {"syscall-arg", "arg1", "arg2", "arg3", "arg4"} and len(arguments) < MAX_NUMERIC_ARGS_PER_EVENT:
            arguments.append(value)
        elif name in {"address", "vm-address"} and len(addresses) < MAX_NUMERIC_ARGS_PER_EVENT:
            addresses.append(value)
        elif name in {"size-in-bytes", "size", "length"} and len(sizes) < MAX_NUMERIC_ARGS_PER_EVENT:
            sizes.append(value)
    return arguments, addresses, sizes


def filtered_events(events_path: Path, target_pid: int, expected_uuid: str) -> dict[str, object]:
    if file_size(events_path) > MAX_EVENT_EXPORT_BYTES:
        raise CaptureIncomplete("event export exceeded its bound before filtering")
    root = ET.parse(events_path).getroot()
    by_id = {element.attrib["id"]: element for element in root.iter() if "id" in element.attrib}
    unresolved_references = sum(
        1 for element in root.iter() if "ref" in element.attrib and element.attrib["ref"] not in by_id
    )
    if unresolved_references:
        raise CaptureIncomplete(f"event export has {unresolved_references} unresolved XML references")
    retained: list[dict[str, object]] = []
    coverage = {
        "targetRows": 0,
        "rowsWithOfficialFrames": 0,
        "mappingEvents": 0,
        "deallocationEvents": 0,
        "zeroFillEvents": 0,
        "pageCacheHitEvents": 0,
        "otherVmFaultEvents": 0,
        "otherSyscallEvents": 0,
        "otherKdebugEvents": 0,
        "filteredRowsTruncated": False,
        "unresolvedReferenceCount": 0,
    }
    for node in root.iter():
        if tag(node) != "node":
            continue
        schema_element = next((child for child in node if tag(child) == "schema"), None)
        schema = schema_element.attrib.get("name") if schema_element is not None else None
        if schema not in {"syscall", "virtual-memory", "kdebug"}:
            continue
        for row in (child for child in node if tag(child) == "row"):
            if target_pid_for_row(row, by_id) != target_pid:
                continue
            coverage["targetRows"] += 1
            op = operation(schema, row, by_id)
            if op in {"mmap", "mach_vm_allocate"}:
                coverage["mappingEvents"] += 1
            elif op in {"munmap", "mach_vm_deallocate"}:
                coverage["deallocationEvents"] += 1
            elif op == "zero_fill":
                coverage["zeroFillEvents"] += 1
            elif op == "page_cache_hit":
                coverage["pageCacheHitEvents"] += 1
            elif op == "other_vm_fault":
                coverage["otherVmFaultEvents"] += 1
            elif op == "other_syscall":
                coverage["otherSyscallEvents"] += 1
            else:
                coverage["otherKdebugEvents"] += 1
            frames = native_frames(row, by_id, expected_uuid)
            if frames:
                coverage["rowsWithOfficialFrames"] += 1
            if len(retained) >= MAX_FILTERED_EVENT_ROWS:
                coverage["filteredRowsTruncated"] = True
                continue
            arguments, addresses, sizes = numeric_fields(row, by_id)
            timestamp = next(
                (
                    integer_value(element)
                    for element in descendants(row, by_id)
                    if tag(element) in {"start-time", "timestamp"}
                ),
                None,
            )
            retained.append(
                {
                    "schema": schema,
                    "timestamp": timestamp,
                    "operation": op,
                    "numericArguments": arguments,
                    "addresses": addresses,
                    "sizes": sizes,
                    "officialImageFrames": frames,
                }
            )
    return {"coverage": coverage, "events": retained}


def run_export(
    name: str,
    command: list[str],
    output_dir: Path,
    target_group: int,
    sampler: TargetSampler,
    deadline: float,
    output_path: Path,
    output_limit: int,
    owned: list[OwnedProcess],
) -> OwnedProcess:
    process = start_owned(name, command, output_dir, target_group, (output_path,))
    owned.append(process)
    wait_owned(process, deadline, target_group, sampler, output_limit)
    if process.handle.returncode != 0:
        raise CaptureIncomplete(f"{name} failed: {output_excerpt(process.stderr_path)}")
    if not output_path.exists():
        raise CaptureIncomplete(f"{name} did not create its output")
    return process


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target-pid", type=int, required=True)
    parser.add_argument("--expected-start-abstime", type=int, required=True)
    parser.add_argument("--expected-executable", required=True)
    parser.add_argument("--expected-image-uuid", required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    args = parser.parse_args()
    if args.target_pid <= 1 or args.expected_start_abstime <= 0:
        parser.error("target PID and start identity must be positive")
    if not re.fullmatch(r"[0-9A-Fa-f-]{36}", args.expected_image_uuid):
        parser.error("expected image UUID must be canonical")
    args.expected_executable = os.path.realpath(args.expected_executable)
    args.expected_image_uuid = args.expected_image_uuid.upper()
    return args


def main() -> int:
    args = parse_args()
    args.output_root.mkdir(parents=True, exist_ok=True)
    private_dir = Path(tempfile.mkdtemp(prefix="own-main-vm-", dir=args.output_root))
    os.chmod(private_dir, 0o700)
    deadline = time.monotonic() + OVERALL_DEADLINE_SECONDS
    owned: list[OwnedProcess] = []
    sampler: TargetSampler | None = None
    protected_target_group = args.target_pid
    receipt: dict[str, object] = {
        "schemaVersion": 1,
        "outcome": "incomplete",
        "capScope": "owned recorder and export children only, not the observed target or shared Instruments services",
        "target": {"pid": args.target_pid, "expectedStartAbstime": args.expected_start_abstime, "expectedImageUuid": args.expected_image_uuid},
        "privateRawTraceRetained": True,
        "filteredEvidencePayloadFree": True,
    }
    try:
        target = read_target_identity(args.target_pid)
        if not target_matches(target, args):
            raise CaptureIncomplete("observed target identity did not match before attachment")
        if target.process_group != args.target_pid:
            raise CaptureIncomplete("observed target process group did not match the pinned target group")
        protected_target_group = target.process_group
        target_group = protected_target_group
        image_uuid = parse_macho_uuid(args.expected_executable, deadline, target_group, private_dir)
        if image_uuid != args.expected_image_uuid:
            raise CaptureIncomplete("observed target executable UUID did not match the expected image")
        receipt["target"] = {
            "pid": target.pid,
            "startAbstime": target.start_abstime,
            "processGroup": target.process_group,
            "initialPhysicalFootprint": target.physical_footprint,
            "initialResidentSize": target.resident_size,
            "imageUuid": image_uuid,
        }
        before_regions = walk_regions(args.target_pid, deadline)
        if before_regions["incomplete"] is not None:
            receipt["regions"] = {"before": before_regions}
            raise CaptureIncomplete(f"before region walk incomplete: {before_regions['incomplete']}")
        sampler = TargetSampler(args)
        target = read_target_identity(args.target_pid)
        if not target_matches(target, args):
            raise CaptureIncomplete("observed target identity changed before recorder startup")
        sampler.start()
        notification = f"com.jwaldrip.omp.incident.main.{secrets.token_hex(16)}"
        waiter = start_owned("notify-waiter", ["/usr/bin/notifyutil", "-1", notification], private_dir, target_group, ())
        owned.append(waiter)
        trace_path = private_dir / "main.trace"
        recorder = start_owned(
            "xctrace-record",
            [
                "xcrun",
                "xctrace",
                "record",
                "--instrument",
                "System Call Trace",
                "--instrument",
                "Virtual Memory Trace",
                "--attach",
                str(args.target_pid),
                "--time-limit",
                f"{RECORDING_SECONDS}s",
                "--no-prompt",
                "--notify-tracing-started",
                notification,
                "--output",
                str(trace_path),
            ],
            private_dir,
            target_group,
            (trace_path,),
        )
        owned.append(recorder)
        ready = False
        while time.monotonic() < deadline:
            enforce_owned(owned, sampler, deadline, target_group, MAX_TRACE_BUNDLE_BYTES)
            if waiter.handle.poll() == 0:
                target = read_target_identity(args.target_pid)
                if not target_matches(target, args):
                    raise CaptureIncomplete("observed target identity changed after tracing notification")
                print("CAPTURE_READY", flush=True)
                ready = True
                break
            if recorder.handle.poll() is not None:
                raise CaptureIncomplete(f"xctrace record ended before readiness: {output_excerpt(recorder.stderr_path)}")
            time.sleep(SAMPLE_INTERVAL_SECONDS)
        if not ready:
            raise CaptureIncomplete("xctrace tracing-started notification was not received")
        wait_owned(recorder, deadline, target_group, sampler, MAX_TRACE_BUNDLE_BYTES)
        target = read_target_identity(args.target_pid)
        if not target_matches(target, args):
            raise CaptureIncomplete("observed target identity changed after recording")
        after_regions = walk_regions(args.target_pid, deadline)
        if after_regions["incomplete"] is not None:
            receipt["regions"] = {"before": before_regions, "after": after_regions}
            raise CaptureIncomplete(f"after region walk incomplete: {after_regions['incomplete']}")
        toc_path = private_dir / "toc.xml"
        toc = run_export(
            "xctrace-export-toc",
            ["xcrun", "xctrace", "export", "--input", str(trace_path), "--toc", "--output", str(toc_path)],
            private_dir,
            target_group,
            sampler,
            deadline,
            toc_path,
            MAX_TOC_BYTES,
            owned,
        )
        events_path = private_dir / "events.xml"
        events = run_export(
            "xctrace-export-events",
            [
                "xcrun",
                "xctrace",
                "export",
                "--input",
                str(trace_path),
                "--xpath",
                '/trace-toc/run[@number="1"]/data/table[@schema="syscall" or @schema="virtual-memory" or @schema="kdebug"]',
                "--output",
                str(events_path),
            ],
            private_dir,
            target_group,
            sampler,
            deadline,
            events_path,
            MAX_EVENT_EXPORT_BYTES,
            owned,
        )
        target = read_target_identity(args.target_pid)
        if not target_matches(target, args):
            raise CaptureIncomplete("observed target identity changed after export")
        filtered = filtered_events(events_path, args.target_pid, args.expected_image_uuid)
        filtered_path = private_dir / "filtered-events.json"
        filtered_path.write_text(json.dumps(filtered, separators=(",", ":")) + "\n")
        samples = sampler.samples
        before_footprint = samples[0].physical_footprint if samples else None
        after_footprint = samples[-1].physical_footprint if samples else None
        footprint_delta = (
            None
            if before_footprint is None or after_footprint is None
            else after_footprint - before_footprint
        )
        region_delta = diff_regions(before_regions, after_regions)
        coverage = filtered["coverage"]
        if (
            footprint_delta == 0
            and region_delta["newMappingBytes"] == 0
            and region_delta["removedMappingBytes"] == 0
            and region_delta["changedResidencyCount"] == 0
        ):
            result_class = "inconclusive-no-observed-growth"
        elif coverage["mappingEvents"] or coverage["deallocationEvents"]:  # type: ignore[index]
            result_class = "mapping-or-deallocation-events-observed"
        elif coverage["rowsWithOfficialFrames"]:  # type: ignore[index]
            result_class = "fault-stacks-only-no-allocation-free-lifetime"
        else:
            result_class = "no-official-stack-coverage"
        receipt.update(
            {
                "outcome": "recorded",
                "ownedProcesses": [process_receipt(process) for process in owned],
                "footprint": {
                    "before": before_footprint,
                    "after": after_footprint,
                    "delta": footprint_delta,
                    "samples": [asdict(sample) for sample in samples],
                },
                "regions": {"before": before_regions, "after": after_regions, "delta": region_delta},
                "eventCoverage": coverage,
                "resultClass": result_class,
                "filteredEvidenceSha256": sha256_file(filtered_path),
                "filteredEvidenceBytes": file_size(filtered_path),
            }
        )
    except CaptureIncomplete as error:
        receipt["failure"] = str(error)
        receipt["ownedProcesses"] = [process_receipt(process) for process in owned]
        if sampler is not None:
            receipt["footprint"] = {"samples": [asdict(sample) for sample in sampler.samples]}
    finally:
        if sampler is not None:
            sampler.stop()
        for process in owned:
            terminate_owned(process, protected_target_group)
    receipt_path = private_dir / "receipt.json"
    receipt_path.write_text(json.dumps(receipt, separators=(",", ":")) + "\n")
    print(json.dumps({"outcome": receipt["outcome"], "receipt": str(receipt_path)}, separators=(",", ":")), flush=True)
    return 0 if receipt["outcome"] == "recorded" else 2


if __name__ == "__main__":
    raise SystemExit(main())
