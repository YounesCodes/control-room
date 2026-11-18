"""Sample a packaged app's opening frames on a disposable, logged-in desktop."""

import argparse
import json
import statistics
import subprocess
import time
import tkinter as tk
from itertools import pairwise
from pathlib import Path

import mss
from PIL import Image


def capture(screen, region):
    shot = screen.grab(region)
    return Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")


def summarize(image):
    samples = image.resize((48, 32), Image.Resampling.NEAREST)
    pixels = samples.get_flattened_data()
    white = sum(min(pixel) >= 225 for pixel in pixels) / len(pixels)
    dark = sum(max(pixel) <= 65 for pixel in pixels) / len(pixels)
    return white, dark


def record(binary, output):
    output.mkdir(parents=True)
    with mss.mss() as screen:
        desktop = screen.monitors[1]
        width, height = min(900, desktop["width"]), min(500, desktop["height"])
        region = {
            "left": desktop["left"] + (desktop["width"] - width) // 2,
            "top": desktop["top"] + (desktop["height"] - height) // 2,
            "width": width,
            "height": height,
        }
        backdrop = tk.Tk()
        backdrop.overrideredirect(True)
        backdrop.geometry(f"{backdrop.winfo_screenwidth()}x{backdrop.winfo_screenheight()}+0+0")
        backdrop.configure(background="white")
        backdrop.update()
        time.sleep(0.5)
        if summarize(capture(screen, region))[0] < 0.98:
            raise RuntimeError("Screen capture did not see the white calibration window")
        backdrop.configure(background="#007070")
        backdrop.update()
        time.sleep(0.3)
        baseline = capture(screen, region)
        baseline.save(output / "before.png")
        average = baseline.resize((1, 1)).getpixel((0, 0))
        if any(abs(a - b) >= 12 for a, b in zip(average, (0, 112, 112))):
            raise RuntimeError("Screen capture did not see the launch backdrop")

        samples = []
        peak_white = -1
        last_thumbnail = None
        frames = []
        started = time.perf_counter()
        app = subprocess.Popen([str(binary.resolve())])
        try:
            while True:
                image = capture(screen, region)
                elapsed = round((time.perf_counter() - started) * 1000, 1)
                white, dark = summarize(image)
                samples.append({"ms": elapsed, "white": white, "dark": dark})
                if white > peak_white:
                    peak_white = white
                    brightest = image
                thumbnail = image.resize((300, 167))
                if thumbnail != last_thumbnail:
                    frames.append((elapsed, thumbnail))
                    last_thumbnail = thumbnail
                if app.poll() is not None:
                    raise RuntimeError(f"App exited during launch with status {app.returncode}")
                painted = dark >= 0.8 and image.convert("L").getextrema()[1] >= 100
                if elapsed >= 20_000 or (elapsed >= 6_000 and painted):
                    break
                time.sleep(0.002)
            image.save(output / "settled.png")
            brightest.save(output / "brightest.png")
        finally:
            app.terminate()
            try:
                app.wait(timeout=15)
            except subprocess.TimeoutExpired:
                app.kill()
                app.wait()
            backdrop.destroy()

    for elapsed, frame in frames:
        frame.save(output / f"frame-{elapsed:07.1f}ms.png")
    times = [0, *(sample["ms"] for sample in samples)]
    gaps = [end - start for start, end in pairwise(times)]
    report = {
        "samples": len(samples),
        "median_gap_ms": round(statistics.median(gaps), 1),
        "max_gap_ms": round(max(gaps), 1),
        "peak_white_fraction": peak_white,
        "first_dark_ms": next((s["ms"] for s in samples if s["dark"] >= 0.8), None),
    }
    (output / "samples.json").write_text(json.dumps(samples), encoding="utf-8")
    print(json.dumps(report), flush=True)
    if not painted:
        raise RuntimeError("Capture did not reach a painted dark UI")
    if peak_white >= 0.5:
        raise RuntimeError("A sampled launch frame was predominantly white")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    record(args.binary, args.output)
