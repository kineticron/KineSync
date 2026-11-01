"""Manual, observation-only simulator startup diagnostic; no app install/launch."""
import concurrent.futures
import datetime
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import threading
import time

RUNTIME = "com.apple.CoreSimulator.SimRuntime.iOS-26-5"


class Recorder:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=False)
        self.lock = threading.Lock()
        self.sequence = 0

    def run(self, name, argv, deadline, stop=None):
        with self.lock:
            self.sequence += 1
            stem = self.root / f"{self.sequence:03d}-{name}"
        record = dict(argv=argv, wall_start=time.time(), monotonic_start=time.monotonic(),
                      exit=None, timedout=False, stopped=False, truncated=False)
        process = None
        selector = selectors.DefaultSelector()
        size = 0
        try:
            with open(str(stem) + ".stdout", "wb", buffering=0) as out, open(
                    str(stem) + ".stderr", "wb", buffering=0) as err:
                if time.monotonic() >= deadline:
                    record["timedout"] = True
                    return record
                process = subprocess.Popen(argv, stdin=subprocess.DEVNULL,
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                           start_new_session=True)
                for pipe, target in ((process.stdout, out), (process.stderr, err)):
                    os.set_blocking(pipe.fileno(), False)
                    selector.register(pipe, selectors.EVENT_READ, target)
                while selector.get_map() or process.poll() is None:
                    expired = time.monotonic() >= deadline
                    stopped = stop is not None and stop.is_set()
                    if expired or stopped or size >= 8 * 1024 * 1024:
                        record.update(timedout=expired, stopped=stopped,
                                      truncated=size >= 8 * 1024 * 1024)
                        # Only this command's isolated process group, never a service.
                        try:
                            os.killpg(process.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        break
                    for key, _ in selector.select(0.1):
                        chunk = os.read(key.fileobj.fileno(), 65536)
                        if not chunk:
                            selector.unregister(key.fileobj)
                        else:
                            key.data.write(chunk)
                            size += len(chunk)
                process.wait(timeout=2)
                record["exit"] = process.returncode
        except Exception as exc:
            record["error"] = repr(exc)
        finally:
            selector.close()
            if process:
                for pipe in (process.stdout, process.stderr):
                    pipe.close()
            record.update(wall_end=time.time(), monotonic_end=time.monotonic())
            record["duration"] = record["monotonic_end"] - record["monotonic_start"]
            record["stdout"] = str(stem) + ".stdout"
            Path(str(stem) + ".json").write_text(json.dumps(record, indent=2))
        return record


def checked(rec, name, argv, deadline):
    result = rec.run(name, argv, deadline)
    if result["exit"] != 0 or result["timedout"] or result.get("truncated"):
        raise RuntimeError(f"{name} failed: {result}")
    return Path(result["stdout"]).read_text()


def resources(rec, stop, deadline):
    while not stop.is_set() and time.monotonic() < deadline:
        for name, argv in (
            ("cpu-processes", ["ps", "-axo", "pid,ppid,state,%cpu,%mem,rss,wchan,comm"]),
            ("vm", ["vm_stat"]), ("pressure", ["memory_pressure", "-Q"]),
            ("disk", ["df", "-h"]), ("load", ["uptime"])):
            rec.run(name, argv, min(deadline, time.monotonic() + 10), stop)
        stop.wait(20)


def main():
    rec = Recorder("simulator-diagnostic")
    overall = time.monotonic() + 840
    stop = threading.Event()
    status = 1
    summary = {"app_install": "OMITTED: no known-good prebuilt app in scope",
               "app_launch": "OMITTED", "runtime": RUNTIME}
    identity = {k: v for k, v in os.environ.items()
                if k.startswith(("RUNNER_", "GITHUB_", "Image")) and
                not any(s in k.upper() for s in ("TOKEN", "SECRET", "PASSWORD"))}
    (rec.root / "identity.json").write_text(json.dumps(identity, indent=2))
    try:
        for name, argv, expected in (
            ("host", ["uname", "-a"], None),
            ("os", ["sw_vers"], None),
            ("xcode", ["xcodebuild", "-version"], "Xcode 26.6"),
            ("sdk", ["xcrun", "--sdk", "iphonesimulator", "--show-sdk-version"], "26.5"),
            ("sdk-path", ["xcrun", "--sdk", "iphonesimulator", "--show-sdk-path"], None)):
            output = checked(rec, name, argv, min(overall, time.monotonic() + 20))
            if expected and expected not in output:
                raise RuntimeError(f"unexpected {name}: {output}")
        if os.environ.get("DEVELOPER_DIR") != "/Applications/Xcode_26.6.app/Contents/Developer":
            raise RuntimeError("DEVELOPER_DIR mismatch")
        # Inventory, boot and bootstatus share ONE 600-second deadline.
        startup = min(overall - 100, time.monotonic() + 600)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            pool.submit(resources, rec, stop, startup)
            pool.submit(rec.run, "host-log", [
                "/usr/bin/log", "stream", "--style", "ndjson", "--level", "info",
                "--predicate", 'process CONTAINS "CoreSimulator" OR subsystem CONTAINS "CoreSimulator"'],
                startup, stop)
            try:
                runtimes = json.loads(checked(rec, "runtimes",
                    ["xcrun", "simctl", "list", "runtimes", "-j"], startup))
                if not any(r["identifier"] == RUNTIME and r.get("isAvailable")
                           for r in runtimes["runtimes"]):
                    raise RuntimeError("exact runtime unavailable")
                devices = json.loads(checked(rec, "inventory",
                    ["xcrun", "simctl", "list", "devices", "available", "-j"], startup))
                device = next(d for d in devices["devices"].get(RUNTIME, [])
                              if d["name"] == "iPhone 17" and d.get("isAvailable"))
                summary["selection"] = dict(device, runtime=RUNTIME)
                (rec.root / "selection.json").write_text(json.dumps(summary["selection"], indent=2))
                if device["state"] != "Booted":
                    checked(rec, "boot", ["xcrun", "simctl", "boot", device["udid"]], startup)
                checked(rec, "bootstatus",
                        ["xcrun", "simctl", "bootstatus", device["udid"], "-b"], startup)
                status = 0
            finally:
                stop.set()
    except Exception as exc:
        summary["error"] = repr(exc)
    finally:
        # Separate final collection budget; cannot change simulator result.
        final = min(overall, time.monotonic() + 80)
        rec.run("final-log", ["/usr/bin/log", "show", "--last", "2m", "--style",
                "ndjson", "--predicate", 'process CONTAINS "CoreSimulator"'],
                min(final, time.monotonic() + 20))
        rec.run("final-processes", ["ps", "-axo", "pid,ppid,state,%cpu,%mem,rss,wchan,comm"],
                min(final, time.monotonic() + 10))
        reports = []
        for directory in (Path.home() / "Library/Logs/DiagnosticReports",
                          Path("/Library/Logs/DiagnosticReports")):
            try:
                for path in list(directory.iterdir())[:200]:
                    stat = path.stat()
                    reports.append(dict(path=str(path), size=stat.st_size, mtime=stat.st_mtime))
            except OSError:
                pass
        (rec.root / "crash-metadata.json").write_text(json.dumps(reports, indent=2))
        summary.update(exit=status, finished=datetime.datetime.now(datetime.timezone.utc).isoformat())
        (rec.root / "result.json").write_text(json.dumps(summary, indent=2))
    return status


if __name__ == "__main__":
    raise SystemExit(main())
