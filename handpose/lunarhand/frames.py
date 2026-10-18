"""WiLoR/HaMeR output -> the landmark format the phone tracker already sends for MediaPipe (PLAN.md §9.5).

Both models' MANO wrappers (the same code) give 21 keypoints in the OpenPose hand order (wrist, thumb CMC..tip,
index MCP..tip, ...), which is the same order as MediaPipe, so the simulator's gesture code needs no changes. Pure
numpy: no torch, unit-tested.
"""

from __future__ import annotations

import numpy as np


def to_landmarks(kp3d: np.ndarray, cam_t: np.ndarray, focal: float, width: int, height: int,
                 is_right: bool, score: float) -> dict:
    """One hand as MediaPipe-style landmarks.

    kp3d:  (21, 3) metres, MANO frame already mirrored for left hands (AnyHandPredictor does this)
    cam_t: (3,) full-image camera translation, so camera space = kp3d + cam_t (x right, y down, z forward)

    Returns lm: image-normalised [x, y, z] (z = depth relative to the wrist, in units of image width, like
    MediaPipe), wlm: metres relative to the hand's centroid (MediaPipe world landmarks), and the true handedness
    (the YOLO detector sees the unmirrored image, unlike MediaPipe's selfie-mirrored convention).
    """
    cam = np.asarray(kp3d, dtype=np.float64) + np.asarray(cam_t, dtype=np.float64)[None, :]
    z = np.maximum(cam[:, 2], 1e-3)
    u = (focal * cam[:, 0] / z + width / 2.0) / width
    v = (focal * cam[:, 1] / z + height / 2.0) / height
    rel_z = (cam[:, 2] - cam[0, 2]) * focal / (z[0] * width)
    world = cam - cam.mean(axis=0)
    return {
        "lm": np.round(np.stack([u, v, rel_z], axis=1), 4).tolist(),
        "wlm": np.round(world, 4).tolist(),
        "hand": "Right" if is_right else "Left",
        "score": round(float(score), 3),
    }
