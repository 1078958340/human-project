"""Extract all hands from a local video using the project's MediaPipe model."""

import argparse
import hashlib
import json
import shutil
import tempfile
import uuid
from pathlib import Path

import cv2
import mediapipe as mp
from mediapipe.tasks.python import BaseOptions
from mediapipe.tasks.python.vision import HandLandmarker, HandLandmarkerOptions, RunningMode


def digest(path):
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def frame_hands(result):
    hands = []
    for index, landmarks in enumerate(result.hand_landmarks):
        label = result.handedness[index][0]
        hands.append({
            "label": label.category_name,
            "score": round(label.score, 6),
            "landmarks": [
                {axis: round(getattr(point, axis), 6) for axis in ("x", "y", "z")}
                for point in landmarks
            ],
        })
    return hands


def extract(stream, model, mirrored):
    options = HandLandmarkerOptions(
        base_options=BaseOptions(model_asset_buffer=model.read_bytes()),
        running_mode=RunningMode.VIDEO,
        num_hands=2,
    )
    fps = stream.get(cv2.CAP_PROP_FPS)
    if not 1 <= fps <= 240:
        raise ValueError("The video must report a valid frame rate.")
    previous_ms = -1
    frames = []
    with HandLandmarker.create_from_options(options) as detector:
        while (decoded := stream.read())[0]:
            image = decoded[1]
            source_ms = stream.get(cv2.CAP_PROP_POS_MSEC)
            fallback_ms = len(frames) * 1000 / fps
            timestamp = max(previous_ms + 1, round(source_ms if source_ms > previous_ms else fallback_ms))
            previous_ms = timestamp
            rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
            hands = frame_hands(detector.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), timestamp))
            # Keep the original single-hand projection so archived v3 can replay the same input.
            only = hands[0] if len(hands) == 1 else None
            points = None if not only else [
                {**p, "x": p["x"] if mirrored else round(1 - p["x"], 6)} for p in only["landmarks"]
            ]
            side = None if not only else only["label"]
            if mirrored and side in ("Left", "Right"):
                side = "Left" if side == "Right" else "Right"
            frames.append({
                "tMs": timestamp, "aspect": image.shape[1] / image.shape[0],
                "hand": points, "side": side, "handScore": only["score"] if only else None,
                "coordinateSystem": "body-right-v1", "sourceMirrored": mirrored,
                "trackerVersion": "single-hand-v5", "hands": hands,
            })
    if not frames:
        raise ValueError("The video contains no decodable frames.")
    return fps, frames


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--mirror", choices=["mirrored", "unmirrored"], required=True)
    args = parser.parse_args()
    if args.output.exists():
        parser.error("output already exists")
    model = Path(__file__).resolve().parent / "vendor" / "hand_landmarker.task"
    mirrored = args.mirror == "mirrored"
    with tempfile.TemporaryDirectory(prefix="gesture-decode-") as directory:
        stream = cv2.VideoCapture(str(args.video))
        if not stream.isOpened():
            stream.release()
            # OpenCV on Windows may fail to open a valid Unicode source path.
            staged = Path(directory) / f"source{args.video.suffix}"
            shutil.copyfile(args.video, staged)
            stream = cv2.VideoCapture(str(staged))
        try:
            if not stream.isOpened():
                raise ValueError("Cannot open the source video.")
            fps, frames = extract(stream, model, mirrored)
        finally:
            stream.release()
    payload = {
        "version": 3, "runId": str(uuid.uuid4()), "trackerVersion": "single-hand-v5",
        "coordinateSystem": "body-right-v1", "mode": "capture",
        "source": {
            "kind": "video", "name": args.video.name, "sourceMirrored": mirrored,
            "sha256": digest(args.video), "framesPerSecond": fps,
            "extractor": f"MediaPipe {mp.__version__} / OpenCV {cv2.__version__}",
            "modelSha256": digest(model),
        },
        "frames": frames,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8") as file:
        json.dump(payload, file, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    print(f"{len(frames)} frames, {frames[-1]['tMs']} ms, {args.output}")


if __name__ == "__main__":
    main()
