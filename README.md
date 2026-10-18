# Handsense

**A personal astronaut glove that lets you feel what lunar equipment is doing.**
HackHarvard 2026 · SpaceXAI "Make It Legendary"

A spacesuit is a pressurised balloon. Astronauts can't feel or hear what their tools and vehicles are doing, so they
work from a small visor window and instrument readouts. Handsense puts that information back in their hand: five
vibration motors on a glove let you *feel* a drill biting into rock and a rover crossing real NASA terrain on the rim
of Shackleton crater.

## What it does

- **Feel the equipment.** Soft regolith throbs gently, hard basalt grinds, and a drill stall goes silent, then hits
  three heavy beats. The rover rumbles with speed, taps the left or right side of your hand on rough ground, and
  sounds a siren when the slope gets too steep.
- **Tap in with NFC.** Touch the glove to a machine and it knows who you are. Your own sensitivity, safety limits
  and confirmation pattern load instantly.
- **Control it with your hand.** A phone camera tracks your hand: a fist lowers the drill bit or brakes the rover, an
  open hand raises the bit or accelerates.
- **Talk to CAPCOM.** Grok Voice changes settings by voice ("increase my terrain sensitivity") and answers "why is my
  glove buzzing?". Grok Imagine designs each astronaut's mission patch.

## What you'll see in the demo

1. Tap the glove on the drill press: "Welcome, Cmdr. Ana Rivera", and two crisp pulses confirm it's her glove.
2. Make a fist: the bit drills into regolith and the glove hums and throbs. The five bars on screen show each
   finger's motor live.
3. Tap in again at the rover, then drive with an open hand and brake with a fist while the glove reports the terrain.
4. Hold **V** and talk to Grok CAPCOM.

## What the glove feels like

Each sensation differs in rhythm, place on the hand and texture, not just strength, so you can tell them apart
without looking.

| You feel | It means |
|---|---|
| A gentle hum with a slow, even throb | Drilling soft regolith |
| Strong, gritty, irregular jolts | Grinding hard basalt |
| Silence, then three heavy beats | **Drill stall**: open your hand to raise the bit |
| A punch in the middle finger that spreads and fades | The bit broke through the sample |
| A rumble that grows stronger and throbs faster | Rover speed |
| Random taps on the thumb side or the pinky side | Left or right wheels on rough ground |
| Silence, then a siren swapping between thumb and pinky side | **Slope warning**: NASA's measured slope exceeds your limit |
| Two crisp pulses (or your own pattern) | Your glove was recognised |
| A low, rough, stuttering buzz | Not authorised |

The full table and the tuning behind it are in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#what-the-glove-feels-like).

## How it works

```
Phone camera ──hand frames──►┐
                             ▼
 Browser sim (Three.js) ◄──► Python hub ──Bluetooth / USB──► ESP32 glove (5 vibration motors)
  NASA terrain, drill,       haptic engine (100 Hz),               ▲
  rover, HUD, voice          profiles, voice tools          NFC reader ◄── tap ── glove tag
        │                          │
        ▼                          ▼
  Grok Voice (CAPCOM)       Grok Imagine (mission patches)
```

- **Glove:** an ESP32 drives five vibration motors, one per finger, over Bluetooth or USB. Each motor is calibrated
  for its dead zone and kept inside a thermal budget.
- **Hub:** a Python server turns what the sim reports (drill resistance, wheel contact, slope) into haptic patterns 100
  times a second. It also loads the astronaut's profile on an NFC tap and checks every voice command before acting
  on it.
- **Simulator:** a Three.js world built on NASA LOLA elevation data from the lunar south pole, with a core-sampling
  drill press and a rover.
- **Hand tracking:** MediaPipe runs on the phone. For the gloved hand, the phone can instead stream frames to WiLoR or
  HaMeR on the laptop GPU, at 24 fps.
- **Mission Assistant:** press **H** (or ask CAPCOM) and it explains what the glove is signalling right now and what
  to do about it.

## Built with

| | |
|---|---|
| **Grok Voice** (xAI Realtime API) | CAPCOM. Push-to-talk, and Grok can act only through 8 whitelisted tools that the hub validates: adjust haptics, check terrain or equipment, play a test pattern, redesign a patch, and more |
| **Grok Imagine** | Each astronaut's mission patch. "Give me a new patch with a rover on it" redesigns it by voice |
| **NASA LOLA** | Real elevation data from the rim of Shackleton crater (5 m per pixel) |
| **Hardware** | ESP32, 5 ERM vibration motors, NFC tags and an ACR122U reader |
| **Computer vision** | MediaPipe, WiLoR (AnyHand), HaMeR |
| **Cursor** | Our development environment; see [docs/CURSOR_LOG.md](docs/CURSOR_LOG.md) |

## Run it

```bash
cp .env.example .env     # add XAI_API_KEY for voice and mission patches
scripts/certs.sh         # once: trusted local HTTPS
scripts/dev.sh           # hub + simulator, no glove needed
# open https://localhost:5173/ and press ? for controls
```

No hardware? The sim runs without a glove: walk up to the drill press or rover and press **N** to simulate an NFC tap.
Connecting the real glove, the NFC reader and the phone tracker, plus the full controls and tests, is covered in
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Honest limitations

- An NFC tag ID identifies the wearer; it does not authenticate them.
- The terrain is a 1.28 km crop. Fine craters and boulders are synthetic (toggle them with **F**), and sample
  hardness is simulated, not measured.
- Rover physics is simplified, and steering is keyboard-only for now.
- We designed and tuned the haptic mappings ourselves; they are not validated for flight.

## Repo map

| Directory | What |
|---|---|
| `hub/` | Python hub: haptic engine, glove connection, NFC, profiles, voice tools, mission patches |
| `sim/` | Three.js simulator and the phone hand tracker |
| `handpose/` | Optional laptop-GPU hand tracker (WiLoR / HaMeR) |
| `firmware/glove/` | ESP32 glove firmware |
| `agent/` | Mission Assistant rules |
| `terrain/` | NASA LOLA processing |
| `data/` | Astronaut profiles and mission patches |

Background and design rationale: [DESIGNDOC.md](DESIGNDOC.md).

## Credits

Terrain: NASA GSFC Planetary Geodesy Data Archive, *High-Resolution LOLA Topography for Lunar South Pole Sites*
(Site04, Shackleton rim, 5 m/px). Barker, M. K., et al. (2021), *Improved LOLA elevation maps for south pole landing
sites: Error estimates and their impact on illumination conditions*, Planetary & Space Science 203, 105119.
doi:10.1016/j.pss.2020.105119.
