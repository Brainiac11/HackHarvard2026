# Handsense developer guide

Setup, hardware, controls and tests. For what the project is, start with the [README](../README.md).

## Setup

```bash
cp .env.example .env            # add XAI_API_KEY (voice + patches)
scripts/certs.sh                # once: locally-trusted HTTPS via mkcert, so the browser doesn't warn
scripts/dev.sh                  # hub (null glove) + simulator
# open https://localhost:5173/, press ? for controls
```

The hub reads `.env` only when it starts, so restart `dev.sh` after editing it. `dev.sh` refuses to start if
ports 8000/5173 are still held by an old hub or simulator.

Real hardware:

```bash
scripts/dev.sh --glove ble --nfc auto                 # or --glove serial:/dev/ttyUSB0
scripts/dev.sh --glove espcmd --nfc auto              # ESP32 running bluetooth_ESP32/ESP32_HackHarvard.ino
scripts/dev.sh --glove ble --nfc auto --log-telemetry # also record sim state to data/sessions/
```

NFC reader (ACR122U): run `scripts/setup_nfc.sh` once (sudo). It unloads and blacklists the kernel `pn533_usb`
driver that grabs the reader, restarts pcscd and installs `pyscard`. New tags are unknown until enrolled: walk to
the drill press or rover in the sim, tap the tag, then press **N** (Rivera) or **Shift+N** (Okafor). The UID is saved in
`data/profiles.json`, and later taps at a piece of equipment authorize it.

Phone hand tracker: open the `tracker.html` URL printed by `dev.sh` in iPhone Safari, then tap **Start**. If Safari
refuses the WebSocket, run `scripts/certs.sh` and trust the mkcert root CA on the phone (`$(mkcert -CAROOT)/rootCA.pem`;
PLAN.md §9.6). Re-run `scripts/certs.sh` whenever the laptop's LAN IP changes.

## Controls

| Key | Action |
|---|---|
| WASD / mouse | walk, look, drive (click to capture the mouse) |
| E | step up to / away from the drill press · board / exit rover |
| Space, S or right mouse · W | drill press: lower the bit (hold) · raise it; release to hold |
| A / D (at the drill press) | slide the table to put the other sample under the bit |
| N / Shift+N | simulate glove tap (Rivera / Okafor); after an unknown tag is scanned, enroll it to Rivera / Okafor |
| H · J | ask the Mission Assistant · auto-coach on/off |
| V (hold) · T · G | talk to CAPCOM · type to CAPCOM · CAPCOM reads assistant alerts |
| F | synthetic fine terrain detail on/off (NASA LOLA only vs LOLA + synthetic) |
| C · R · Q · K · ? | rover camera · reset rover · reset samples · calibrate hand · help |
| P | graphics quality: high (ambient occlusion + bloom) · low (bloom; 2x MSAA, 2048² shadows) · off; or open the sim with `?gfx=low` |
| W · S · A / D (in the rover) | throttle · brake, then reverse once stopped · steer (keyboard only); Shift boosts |

With the tracker running, a **fist** near authorized equipment takes the controls.
At the drill press: **closed fist** = lower the bit, **open hand** = raise it, anything in between holds it.
In the rover: **open hand** = accelerate, **fist** = brake, anything in between coasts; steer with **A**/**D** (keyboard
only for now). Holding W or S overrides the hand, and the speedometer shows what the hand is asking for.

The drill press: a floor-standing core-sampling press at the work site, with a Regolith brick (soft) and a Basalt
core (hard) clamped on its cross-slide table. Stepping up to it puts you at the operator station, looking down at
the bit. The spindle starts as soon as the quill leaves its top stop and stops when it is back. The bit feeds freely
down to the sample, then only as fast as the material allows: the brick breaks through in about 12 s, while basalt
barely advances, and pushing on raises the stall warning. After a breakthrough, raise the bit and a fresh sample loads.
The table only moves with the bit raised clear of the samples. The panel LCD shows bore depth, spindle speed and load.

## What the glove feels like

Each sensation differs from the others in rhythm, place on the hand, envelope or texture, not just in strength.
Quiet states sit just above each motor's dead zone and strong ones near the 180/255 duty ceiling. Duty follows a
perceptual curve, so equal steps feel equal. Events and alerts start from a short silence and land with a brief
overdriven accent: up to 230 for at most 60 ms, inside a thermal budget that keeps every motor's 0.5 s average at or
below 180.

| You feel | It means |
|---|---|
| A faint, smooth hum | Drill spindle running, the bit is not touching anything |
| A gentle hum with a slow, even throb | Cutting soft regolith |
| Strong, gritty, irregular jolts | Grinding hard basalt |
| Silence, then three heavy beats in the index, middle and ring fingers | **Drill stall**: open your hand to raise the bit |
| A punch in the middle finger that spreads across the hand and fades | The bit broke through the sample |
| A rumble that grows stronger and throbs faster | Rover speed |
| Random taps on the thumb side or the pinky side, denser on rougher ground | Left or right wheels on rough ground |
| One hard hit on one side that dies away | A wheel struck a rock or a crater edge |
| Silence, then a siren: thumb side and pinky side take turns, faster and stronger | **Slope warning**: NASA's measured slope under the rover exceeds your limit |
| Two crisp pulses, three quick pulses, or a wave across the fingers and back | Your glove was recognised (your profile's pattern) |
| A swell then a tap in the index and middle fingers · two swells on both edges of the hand | Drill press · rover profile active |
| One tap on the middle finger · a ripple thumb→pinky (stronger) or pinky→thumb (fading) | Command accepted · a setting went up or down |
| A low, rough, stuttering buzz | Not authorized, or the glove was not recognised |

Details and numbers are in PLAN.md §7. To try one on the glove, run `haptic_cli.py ... play <name>` (see
[Hardware bring-up](#hardware-bring-up)).

## Laptop hand tracking (WiLoR, HaMeR)

MediaPipe on the phone struggles with the gloved hand. The tracker can instead stream frames to a model on the laptop
GPU: [AnyHand](https://github.com/chen-si-cs/AnyHand)'s WiLoR (fine-tuned on synthetic hand and hand-object data, the
default) or [HaMeR](https://github.com/geopavlakos/hamer) (ViT-H). Both run behind AnyHand's YOLO hand detector and
their landmarks come back in MediaPipe's format, so the sim is unchanged.

```bash
scripts/setup_anyhand.sh ~/Downloads/mano_v1_2.zip   # once: code, ~2.6 GB weights, CUDA env, MANO, self-test
scripts/setup_anyhand.sh --hamer                     # adds HaMeR (pinned commit) and its ~2.7 GB weights
scripts/dev.sh --anyhand                             # also starts handpose on :8001 (proxied at /anyhand)
scripts/dev.sh --hamer                               # the same, loading HaMeR first
```

On the phone tracker, tap **Engine** to go from `phone` (MediaPipe) to the laptop, on whichever model it already
serves (HaMeR after `--hamer`), then to the other model, then back to `phone`. The laptop holds one model at a time:
a switch frees the other one and loads the new one in the background (about 5 s), while the tracker says
"loading HaMeR…" and uses the phone model. If a model can't load (not installed, out of memory) the tracker says why
and the previous model comes back. The phone's choice is the server's for every client; `--model` (or `HAND_MODEL` in
`.env`) only picks what loads first, and `--keep-models` keeps both on the GPU so switching back is instant (5.6 GB of
VRAM). It falls back to the phone model whenever the laptop server is unavailable and reconnects by itself. The
`delegate` readout shows the model with GPU and capture-to-landmarks ms, and `fps` and `seen` compare engines. Set
`GLOVE_HAND=left|right` in `.env` so the laptop models track the gloved hand, not the bare one.
`HAMER_WEIGHTS=anyhand` (after `setup_anyhand.sh --hamer-weights anyhand`) swaps in AnyHand's fine-tune of HaMeR,
or a path to a checkpoint of your own.

Measured on an RTX 5060 Laptop GPU with the phone's 640×480 JPEGs (fp16, one hand per frame):

| | WiLoR | HaMeR |
|---|---|---|
| server time per frame (median, p90) | 41 ms, 44 ms | 40 ms, 44 ms |
| frames per second (two in flight, like the phone) | 24 | 24 |
| VRAM | 3.0 GB | 3.1 GB |
| switch to it (free the other, load) | 5 s | 5–6 s |

Both are ViT-H on the same crop, so they cost the same. JPEG decoding and cropping run on the CPU: with the CPU
saturated (a software-rendered browser alongside), both slowed to about 55 ms.

MANO needs a free account at <https://mano.is.tue.mpg.de> ("Models & Code"). Needs an NVIDIA GPU (tested on an RTX
5060 Laptop, torch 2.11 + CUDA 12.8). Licences: AnyHand weights and WiLoR are CC-BY-NC-ND; HaMeR's code is MIT, but
its weights come without a licence of their own, are trained on research datasets and contain MANO, which is
non-commercial. All of it stays in the git-ignored `third_party/`.

## Hardware bring-up

```bash
uv tool install platformio
cd firmware/glove && pio run -e esp32dev -t upload          # esp32s3 / esp32c3 envs also defined
uv run --project hub python scripts/haptic_cli.py --serial /dev/ttyUSB0 pattern 1     # double pulse
uv run --project hub python scripts/haptic_cli.py --serial /dev/ttyUSB0 calibrate     # per-motor dead zone
uv run --project hub python scripts/haptic_cli.py --ble soak 600                      # 10-min BLE soak
uv run --project hub python scripts/haptic_abx.py --serial /dev/ttyUSB0 --name alex   # can people tell them apart?
uv run --project hub python scripts/haptic_cli.py --espcmd play slope                 # any hub pattern (ESPcmd sketch too)
uv run --project hub python scripts/haptic_abx.py --espcmd --name alex --set alerts   # ABX sets: core drill rover alerts ui
```

Linux prep: `sudo usermod -aG dialout $USER`, `sudo apt remove brltty`, and for PC/SC NFC readers
`scripts/setup_nfc.sh` (installs pcscd/libccid, blacklists `pn533_usb`, runs `uv sync --extra nfc`; PLAN.md §6.1).

## How the Grok integration works

- *Voice*: the browser connects to `wss://api.x.ai/v1/realtime` with a 5-minute ephemeral token minted by the hub
  (`/api/voice/token`). Push-to-talk, PCM16 24 kHz. Grok can only act through 8 whitelisted function tools that the
  hub validates deterministically (`hub/lunarhub/commands/`), e.g. "increase my terrain sensitivity" or "why is my
  glove buzzing?" (answered by the Mission Assistant).
- *Imagine*: each astronaut's mission patch is generated with `grok-imagine-image` and cached in `data/patches/`;
  "give me a new patch with a rover on it" regenerates it by voice.

## Tests

```bash
cd hub && uv run pytest            # protocol, haptic engine, mission/commands, xAI clients, app integration
cd agent && uv run pytest          # Mission Assistant rules and prompts
cd sim && npm test                 # gestures, One Euro filter, rover physics + controls, drill press, terrain, sky, glove
cd handpose && uv run pytest       # landmark conversion, MANO chumpy stripping, frame protocol, model switching
g++ -std=c++17 -I firmware/glove/src firmware/glove/test/host_protocol_test.cpp -o /tmp/p && /tmp/p < vectors.hex
```

In a dev build (`npm run dev`), `__lh.stats()` in the browser console returns the last frame's draw calls and
triangles over every pass (shadows, scene, ambient occlusion, bloom), texture/geometry/shader counts, CPU frame time
and the startup breakdown (time per loading stage and per baked texture). Production builds leave it out.
