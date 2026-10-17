import numpy as np

from lunarhand.frames import to_landmarks


def synthetic_hand() -> np.ndarray:
    """21 points, wrist at the origin, fingers along -y (up in the image), ~9 cm wrist -> middle MCP."""
    pts = np.zeros((21, 3))
    for f, x in enumerate([-0.035, -0.025, 0.0, 0.022, 0.042]):
        for j in range(4):
            pts[1 + f * 4 + j] = [x, -0.07 - 0.025 * j if f else -0.03 - 0.02 * j, 0.004 * j]
    return pts


def test_projection_matches_pinhole_and_centres_world():
    kp, cam_t, focal, w, h = synthetic_hand(), np.array([0.05, 0.02, 0.45]), 600.0, 640, 480
    out = to_landmarks(kp, cam_t, focal, w, h, is_right=True, score=0.91)
    lm, wlm = np.array(out["lm"]), np.array(out["wlm"])
    assert lm.shape == (21, 3) and wlm.shape == (21, 3)
    wrist = kp[0] + cam_t
    assert np.allclose(lm[0, :2], [(focal * wrist[0] / wrist[2] + w / 2) / w,
                                   (focal * wrist[1] / wrist[2] + h / 2) / h], atol=1e-4)
    assert lm[0, 2] == 0  # depth is relative to the wrist
    assert np.allclose(wlm.mean(axis=0), 0, atol=1e-3)
    assert np.allclose(wlm[9] - wlm[0], kp[9] - kp[0], atol=1e-3)  # metric shape preserved
    assert lm[12, 1] < lm[0, 1]  # fingertips above the wrist in the image (y down)
    assert out["hand"] == "Right" and out["score"] == 0.91


def test_left_hand_label_and_far_hand_is_smaller():
    kp = synthetic_hand()
    near = to_landmarks(kp, np.array([0, 0, 0.3]), 600.0, 640, 480, False, 0.5)
    far = to_landmarks(kp, np.array([0, 0, 0.6]), 600.0, 640, 480, False, 0.5)
    size = lambda o: np.hypot(*(np.array(o["lm"][9][:2]) - np.array(o["lm"][0][:2])))
    assert near["hand"] == "Left" and size(near) > 1.9 * size(far)
