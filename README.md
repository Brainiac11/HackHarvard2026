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
| `firmware/glove/` | ESP32 firmware (PlatformIO): BLE + serial, watchdog, kick-start, built-in patterns |
| `agent/` | `lunar_agent`: Mission Assistant (schemas, rules, prompts, Chalk Function) and the eval harness |
| `terrain/` | NASA LOLA processing pipeline (`build.py`) |
| `scripts/` | dev launcher, glove bring-up CLI, haptic distinguishability test, fake NFC |
| `data/` | astronaut profiles, mission patches, session logs |

## Quick start

```bash
cp .env.example .env            # add XAI_API_KEY (voice + patches) and Chalk settings when available
scripts/dev.sh                  # hub (null glove) + simulator
# open https://localhost:5173/ (accept the self-signed cert), press ? for controls
```

Real hardware:

```bash
scripts/dev.sh --glove ble --nfc auto                 # or --glove serial:/dev/ttyUSB0
scripts/dev.sh --glove ble --nfc auto --assistant chalk --log-telemetry
```

Phone hand tracker: open the `tracker.html` URL printed by `dev.sh` in iPhone Safari, then tap **Start**. If Safari
refuses the WebSocket with a self-signed cert, put mkcert certs in `sim/certs/lan.pem` + `sim/certs/lan-key.pem`
and trust the mkcert root CA on the phone (PLAN.md §9.6).

### Controls

| Key | Action |
|---|---|
| WASD / mouse | walk, look, drive (click to capture the mouse) |
| E | pick up / put back drill · board / exit rover |
| Space or right mouse | drill trigger |
| N / Shift+N | simulate glove tap (Rivera / Okafor) when no reader is connected |
| H · J | ask the Mission Assistant · auto-coach on/off |
| V (hold) · T · G | talk to CAPCOM · type to CAPCOM · CAPCOM reads assistant alerts |
| F | synthetic fine terrain detail on/off (NASA LOLA only vs LOLA + synthetic) |
| C · R · Q · K · ? | rover camera · reset rover · reset samples · calibrate hand · help |

With the tracker running: **fist** near equipment = grab, **index curl** = drill trigger / throttle,
**hand roll** = steer (while gripping), **open palm** = brake.

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
`sudo apt install pcscd libccid pcsc-tools` + blacklist `pn533_usb` (PLAN.md §6.1). Install NFC extras with
`cd hub && uv sync --extra nfc`.

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
cd sim && npm test                 # gestures, One Euro filter, rover physics stability
g++ -std=c++17 -I firmware/glove/src firmware/glove/test/host_protocol_test.cpp -o /tmp/p && /tmp/p < vectors.hex
```

## Data and credits

Terrain: NASA GSFC Planetary Geodesy Data Archive, *High-Resolution LOLA Topography for Lunar South Pole Sites*
(Site04, Shackleton rim, 5 m/px). Barker, M. K., et al. (2021), *Improved LOLA elevation maps for south pole landing
sites: Error estimates and their impact on illumination conditions*, Planetary & Space Science 203, 105119.
doi:10.1016/j.pss.2020.105119. Fine-scale craters, boulders and noise in the simulator are synthetic and can be
toggled off (F). Sample hardness values are simulated, not measurements.

**Honest limitations**: a tag UID is identification, not authentication. The terrain is a 1.28 km crop. Rover
physics is a simplified model. The haptic mappings are designed and tuned by us, not validated for flight.
