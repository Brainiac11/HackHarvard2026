# LunarHaptics

**A personalized astronaut glove that turns lunar equipment data into physical sensations.**
HackHarvard 2026 · SpaceXAI "Make It Legendary" · Best Data-Driven Agent Built on Chalk

Five vibration motors on a glove let an astronaut *feel* what a simulated drill and rover are doing on real NASA
terrain from the rim of Shackleton crater. An NFC tag on the glove identifies the wearer and loads their personal
feedback profile. A head-mounted iPhone tracks the hand. **Grok Voice** is CAPCOM. **Grok Imagine** designs each
astronaut's mission patch. A **Chalk-hosted Mission Assistant** explains what the glove is telling you and what to do.

- Product/pitch: [DESIGNDOC.md](DESIGNDOC.md) · Implementation plan: [PLAN.md](PLAN.md) · Evals: [docs/EVALS.md](docs/EVALS.md)

## Architecture

```
iPhone (Safari) ──wss hand.frame──►┐
                                    ▼
 Browser sim (Three.js) ◄──ws──► Python hub ──BLE / USB serial──► ESP32 glove (5× ERM)
   NASA LOLA terrain, drill,        haptic engine (100 Hz), profiles,      ▲
   rover, HUD, Grok Voice ──wss──►  mission state, command handler   USB NFC reader ◄─ tap ─ glove tag
        │ (ephemeral token)         │                  │
        ▼                           ▼                  ▼
   xAI Realtime (CAPCOM)     xAI Images (patches)   Chalk Function: Mission Assistant
                                                     (Grok via Chalk Model Gateway) + Chalk Evaluations
```

| Directory | What |
|---|---|
| `hub/` | Python hub (`lunarhub`): FastAPI WebSockets, haptic engine, glove transports, NFC, profiles, mission state, voice tools, patches, assistant bridge |
| `sim/` | Vite + TypeScript + Three.js simulator (`index.html`) and phone hand tracker (`tracker.html`) |
| `handpose/` | `lunarhand`: optional laptop-GPU hand tracker running WiLoR (AnyHand) or HaMeR, fed JPEG frames by the phone |
| `firmware/glove/` | ESP32 firmware (PlatformIO): BLE + serial, watchdog, kick-start, built-in patterns |
| `agent/` | `lunar_agent`: Mission Assistant (schemas, rules, prompts, Chalk Function) and the eval harness |
| `terrain/` | NASA LOLA processing pipeline (`build.py`) |
| `scripts/` | dev launcher, glove bring-up CLI, haptic distinguishability test, fake NFC |
| `data/` | astronaut profiles, mission patches, session logs |

## Quick start

```bash
cp .env.example .env            # add XAI_API_KEY (voice + patches) and Chalk settings when available
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
scripts/dev.sh --glove ble --nfc auto --assistant chalk --log-telemetry
```

NFC reader (ACR122U): run `scripts/setup_nfc.sh` once (sudo). It unloads and blacklists the kernel `pn533_usb`
driver that grabs the reader, restarts pcscd and installs `pyscard`. New tags are unknown until enrolled: walk to
the drill press or rover in the sim, tap the tag, then press **N** (Rivera) or **Shift+N** (Okafor). The UID is saved in
`data/profiles.json`, and later taps at a piece of equipment authorize it.

Phone hand tracker: open the `tracker.html` URL printed by `dev.sh` in iPhone Safari, then tap **Start**. If Safari
refuses the WebSocket, run `scripts/certs.sh` and trust the mkcert root CA on the phone (`$(mkcert -CAROOT)/rootCA.pem`;
PLAN.md §9.6). Re-run `scripts/certs.sh` whenever the laptop's LAN IP changes.

### Controls

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

### Laptop hand tracking (WiLoR, HaMeR)

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
serves (HaMeR after `--hamer`), then to the other model, then back to `phone`. The laptop holds one model at a time: a switch frees the other one and loads the new one in the background (about 5 s), while the tracker
says "loading HaMeR…" and uses the phone model. If a model can't load (not installed, out of memory) the tracker
says why and the previous model comes back. The phone's choice is the server's for every client; `--model` (or
`HAND_MODEL` in `.env`) only picks what loads first, and `--keep-models` keeps both on the GPU so switching back is
instant (5.6 GB of VRAM). It falls back to the phone model whenever the laptop server is unavailable and reconnects
by itself. The `delegate` readout shows the model with GPU and capture-to-landmarks ms, and `fps` and `seen` compare
engines. Set `GLOVE_HAND=left|right` in `.env` so the laptop models track the gloved hand, not the bare one.
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
```

Linux prep: `sudo usermod -aG dialout $USER`, `sudo apt remove brltty`, and for PC/SC NFC readers
`scripts/setup_nfc.sh` (installs pcscd/libccid, blacklists `pn533_usb`, runs `uv sync --extra nfc`; PLAN.md §6.1).

## How we use the sponsor tech

**Grok (SpaceXAI)**
- *Voice*: the browser connects to `wss://api.x.ai/v1/realtime` with a 5-minute ephemeral token minted by the hub
  (`/api/voice/token`). Push-to-talk, PCM16 24 kHz. Grok can only act through 8 whitelisted function tools that the
  hub validates deterministically (`hub/lunarhub/commands/`), e.g. "increase my terrain sensitivity" or "why is my
  glove buzzing?" (delegated to the Mission Assistant).
- *Imagine*: each astronaut's mission patch is generated with `grok-imagine-image` and cached in `data/patches/`;
  "give me a new patch with a rover on it" regenerates it by voice.
- The Chalk Mission Assistant's LLM is Grok, routed through the Chalk Model Gateway.

**Chalk**
- *Functions*: the Mission Assistant runs as `@chalkcompute.function mission_assistant` (kept warm) and the hub calls
  it live (`agent/lunar_agent/agent.py`).
- *Model Gateway*: all agent LLM traffic (Grok via the `xai` connection; judge model via a second provider).
- *Evaluations*: 4 datasets (auto-labelled synthetic scenarios rendered by the real haptic engine on real LOLA
  cells, adversarial, recorded sessions, 30 blind human-labelled questions), 11 scorers (deterministic, grounding,
  safety, uncertainty, LLM judges), and ablations that remove the NASA data or the glove state
  (`agent/lunar_agent/evals/`, results in [docs/EVALS.md](docs/EVALS.md)).

**Cursor**: development happens in Cursor; see [docs/CURSOR_LOG.md](docs/CURSOR_LOG.md).

## Tests

```bash
cd hub && uv run pytest            # protocol, haptic engine, mission/commands, xAI clients, app integration
cd agent && uv run pytest          # rules, prompts, agent core (fake model), scorers
cd sim && npm test                 # gestures, One Euro filter, rover physics + controls, drill press, terrain, sky, glove
cd handpose && uv run pytest       # landmark conversion, MANO chumpy stripping, frame protocol, model switching
g++ -std=c++17 -I firmware/glove/src firmware/glove/test/host_protocol_test.cpp -o /tmp/p && /tmp/p < vectors.hex
```

In a dev build (`npm run dev`), `__lh.stats()` in the browser console returns the last frame's draw calls and
triangles over every pass (shadows, scene, ambient occlusion, bloom), texture/geometry/shader counts, CPU frame time
and the startup breakdown (time per loading stage and per baked texture). Production builds leave it out.

## Data and credits

Terrain: NASA GSFC Planetary Geodesy Data Archive, *High-Resolution LOLA Topography for Lunar South Pole Sites*
(Site04, Shackleton rim, 5 m/px). Barker, M. K., et al. (2021), *Improved LOLA elevation maps for south pole landing
sites: Error estimates and their impact on illumination conditions*, Planetary & Space Science 203, 105119.
doi:10.1016/j.pss.2020.105119. Fine-scale craters, boulders and noise in the simulator are synthetic and can be
toggled off (F). Sample hardness values are simulated, not measurements.

**Honest limitations**: a tag UID is identification, not authentication. The terrain is a 1.28 km crop. Rover
physics is a simplified model. The haptic mappings are designed and tuned by us, not validated for flight.
