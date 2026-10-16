# LunarHaptics
## Personalized Haptic Interfaces for Lunar Exploration
### HackHarvard 2026 — Technical Design Document

**Target sponsor challenge:** SpaceXAI — Make It Legendary  
**Event:** HackHarvard 2026, October 16–18  
**Project category:** Wearable Hardware, Space Technology, Computer Vision, Human-Computer Interaction, and AI

**Project status:** Proposed hackathon prototype

---

# 1. Executive Summary

LunarHaptics is a wearable haptic interface that enables astronauts to personalize how they interact with equipment and physically feel information about the tools and vehicles they operate.

The system combines a vibration-equipped glove, NFC-based equipment identification, smartphone computer vision, an ESP32 microcontroller, and an interactive 3D lunar environment.

Astronauts wear a glove containing multiple vibration motors positioned near their knuckles. These motors generate tactile sensations that communicate equipment behavior, such as drilling resistance, rover speed, and terrain roughness.

An NFC tag embedded in the glove identifies the user to compatible equipment. When the astronaut scans their glove, the system loads their preferred operating configuration and provides tactile confirmation of successful activation.

A head-mounted smartphone tracks the astronaut's fingers and hand movements, enabling them to see and interact with a corresponding virtual hand inside a lunar simulation.

The laptop coordinates the entire system, receiving tracking data, simulating equipment behavior, and sending feedback commands to the ESP32 over Bluetooth.

For the HackHarvard SpaceXAI challenge, LunarHaptics will also incorporate two additional capabilities:

1. **NASA Lunar Terrain Integration:** Public lunar elevation data will inform the simulated environment and rover terrain feedback.
2. **Grok Voice Integration:** Astronauts will be able to use natural-language commands for simulated equipment selection, status inquiries, and haptic customization.

Together, these capabilities demonstrate a personalized interface that allows astronauts to see, command, and feel equipment interactions.

**Vision:** One glove that recognizes its wearer, adapts to every tool, and turns equipment information into tactile sensations.

---

# 2. Problem Statement

Astronauts operating in lunar environments face several challenges.

## 2.1 Reduced tactile perception

Spacesuit gloves reduce direct tactile sensation. Astronauts may have difficulty perceiving the resistance of materials or subtle equipment behavior through ordinary touch.

This can increase reliance on visual observations and instrument readings.

## 2.2 Cognitive overload

Lunar operations require astronauts to monitor their surroundings, equipment status, navigation, and mission objectives.

Important feedback often competes for limited visual and auditory attention.

A wearable tactile interface provides an additional way of communicating information.

## 2.3 Fragmented equipment controls

Different tools and vehicles have different operating interfaces.

Astronauts may need to adapt to multiple control configurations even when their personal preferences remain consistent.

A portable user profile could help supported equipment automatically load preferred control and feedback settings.

## 2.4 Limited intuitive environmental awareness

A rover operator may see speed and suspension data on an instrument panel but may not intuitively feel how the vehicle is interacting with the terrain.

Haptic feedback could translate equipment telemetry into physically perceptible cues.

---

# 3. Proposed Solution

LunarHaptics integrates four complementary interfaces.

### A. Wearable haptic interface

A glove with vibration motors communicates equipment behavior directly to the astronaut's hand.

### B. NFC equipment personalization

The glove carries an NFC identifier associated with a saved astronaut profile. A reader identifies the profile and activates equipment-specific settings.

### C. Computer vision interaction

A head-mounted smartphone captures the astronaut's hand movements and sends estimated hand landmarks to a laptop-based simulation.

### D. Voice interaction

A Grok Voice-powered assistant enables hands-free commands and equipment inquiries.

These interfaces connect through a central laptop simulation, which interprets user actions and generates corresponding equipment feedback.

---

# 4. System Architecture

## 4.1 Hardware components

| Component | Function |
|---|---|
| Rubber or dishwasher glove | Physical wearable platform |
| Five vibration motors | Localized haptic output |
| ESP32 | Motor control and Bluetooth communication |
| Motor driver circuitry | Safely drives vibration motors |
| NFC tag | Stores an identifier linked to the user |
| USB NFC reader | Reads the glove identifier |
| Head-mounted smartphone | Camera-based hand tracking |
| Laptop | Simulation and system coordination |
| Microphone | Captures astronaut voice commands |
| Power supply | Powers the glove electronics |

## 4.2 Communication architecture

The laptop is the central processing unit.

**Smartphone → Bluetooth → Laptop**

The smartphone processes camera frames and transmits estimated hand landmarks.

**NFC tag → NFC reader → USB → Laptop**

The reader supplies the glove identifier so the simulator can load the appropriate user profile.

**Laptop → Bluetooth → ESP32 → Motors**

The laptop sends haptic commands based on simulation state.

**Microphone → Grok Voice API → Laptop simulation**

Voice requests are interpreted and converted into approved simulator actions or spoken status responses.

**NASA lunar dataset → Terrain processing → Lunar simulation**

Real lunar elevation data informs the simulated terrain, which in turn influences rover movement and haptic feedback.

## 4.3 Central software services

The laptop runs:

- Lunar 3D simulation
- Hand tracking receiver
- NFC profile manager
- Equipment state manager
- Haptic feedback engine
- Bluetooth communication manager
- Lunar terrain data processor
- Grok Voice integration
- Astronaut settings interface

Each subsystem should be independently testable.

---

# 5. Haptic Glove Design

## 5.1 Physical construction

The initial prototype uses a standard rubber glove as the wearable foundation.

Five vibration motors will be mounted approximately near the finger knuckles.

The motors are connected to an ESP32, which receives control commands from the laptop.

The NFC tag will be attached to a convenient location on the glove so the user can tap it against an external NFC reader.

## 5.2 Feedback mechanisms

The glove should support:

- Continuous low-intensity vibration
- Continuous high-intensity vibration
- Short confirmation pulses
- Irregular vibration patterns
- Distinctive warning sequences
- Individually addressed motor feedback

Intensity, duration, rhythm, and motor location can be combined to communicate different types of information.

## 5.3 Example haptic mappings

| Event | Physical response |
|---|---|
| Successful NFC identification | Two short pulses |
| Equipment activated | Short confirmation pattern |
| Soft material drilling | Gentle, steady hum |
| Hard material drilling | Strong, abrasive pulses |
| Rover moving slowly | Low-intensity vibration |
| Rover accelerating | Increasing vibration |
| Rover crossing rough terrain | Irregular pulses |
| High equipment resistance | Strong warning pattern |

These values will be adjusted experimentally based on what users can reliably distinguish.

---

# 6. Hand Tracking and Virtual Interaction

## 6.1 Smartphone computer vision

The smartphone will be mounted on the user's head and directed toward their working hand.

A computer vision framework such as MediaPipe Hands will estimate hand landmarks and finger poses.

The phone will process camera frames locally and transmit relevant tracking information to the laptop.

## 6.2 Virtual hand

The simulation will render a 3D hand representing the user's detected movements.

The virtual hand should support:

- Finger bending
- Hand opening and closing
- Approximate hand rotation
- Basic hand translation
- Simple object interactions

For the hackathon, approximate hand movements and reliable gesture interactions take priority over anatomically exact reconstruction.

## 6.3 Object interaction

The user can manipulate simulated equipment using hand gestures.

For example, closing their fingers while near the drill could cause the virtual hand to grasp it.

Interaction with rover controls could similarly enable steering or throttle input.

Fallback keyboard controls will remain available to preserve a reliable demonstration.

---

# 7. NFC Identity and Personalization

## 7.1 Astronaut identification

Each glove contains an NFC tag with an identifier associated with an astronaut profile.

The laptop stores profiles containing personalized equipment settings.

When the tag is scanned, the system looks up the corresponding profile and activates settings for the currently selected equipment.

The NFC system is an identification mechanism for the prototype, not production-grade secure authentication.

## 7.2 Personalized configuration

Example settings include:

| Parameter | User preference |
|---|---|
| Drill sensitivity | High |
| Rover vibration intensity | Medium |
| Authentication pulse | Double pulse |
| Warning intensity | Maximum |
| Drill motor mapping | Resistance feedback |
| Rover motor mapping | Terrain and speed feedback |
| Preferred input method | Gesture and voice |

## 7.3 Equipment-specific activation

An astronaut selects or approaches the drill.

They scan their glove against the NFC reader.

The laptop loads their drill profile, activates the relevant interaction controls, and confirms the action through haptic feedback.

When the astronaut approaches the rover, the process repeats using the rover's configuration.

The same glove can therefore support multiple equipment types with different feedback behaviors.

---

# 8. Lunar Simulation Environment

## 8.1 Overview

The laptop hosts a 3D lunar environment built using a game engine such as Unity or Godot.

The environment will contain lunar terrain and several interactive objects.

Required simulation elements:

1. Virtual astronaut hand
2. Drill
3. Soft material block
4. Hard material block
5. Controllable rover
6. Lunar terrain with smooth and rough areas

The simulator provides the source of equipment state information that drives the glove.

## 8.2 Drill simulation

The drill interacts with two material types.

### Soft material

The drill penetrates the material with relatively low resistance.

The glove produces a gentle, continuous vibration.

### Hard material

The drill encounters significant resistance and may stop penetrating.

The glove generates stronger, more irregular pulses.

### Feedback calculation

Drill feedback depends on:

- Drill activation
- Contact state
- Material resistance
- Penetration progress

A simplified conceptual model is:

**Drill haptics = f(tool activity, material resistance)**

The hard and soft blocks will use predefined material properties. These are simulated values, not direct measurements from NASA geological data.

## 8.3 Rover simulation

The astronaut can enter the rover and drive across the virtual terrain.

The rover exposes several state values:

- Speed
- Acceleration
- Terrain roughness
- Suspension movement
- Collisions

These values influence the glove's feedback.

For example, driving faster produces increased vibration, while encountering rocky terrain triggers irregular pulses.

The feedback engine combines signals from multiple inputs while keeping the output within the motors' safe operating range.

---

# 9. NASA Lunar Terrain Data Integration

## 9.1 Purpose

To align the project with the SpaceXAI challenge, LunarHaptics will incorporate real lunar data instead of relying solely on procedurally generated terrain.

This expands the project from a fictional lunar simulator into a demonstration informed by actual observations of the Moon.

The strongest integration uses terrain data to influence both the world geometry and the haptic feedback produced during rover driving.

## 9.2 Proposed data sources

**NASA Lunar Reconnaissance Orbiter (LRO)**

The Lunar Reconnaissance Orbiter provides scientific observations of the lunar surface.

Data from its Lunar Orbiter Laser Altimeter (LOLA) can be used to represent elevation and surface characteristics.

**NASA CGI Moon Kit**

NASA provides lunar color and elevation maps prepared for use in 3D rendering software.

Source: https://svs.gsfc.nasa.gov/4720/

**NASA Moon Trek**

Moon Trek provides access to lunar maps, elevation information, and geographical visualization.

Source: https://trek.nasa.gov/moon/

These resources can provide real-world geographical information for the simulated environment.

## 9.3 Data processing pipeline

The proposed pipeline is:

**NASA lunar dataset → Elevation extraction → Heightmap generation → 3D terrain → Rover physics → Haptic engine → ESP32 glove**

### Step 1: Select a lunar region

Choose a small region of the Moon with useful topographical variation.

### Step 2: Obtain elevation measurements

Import a terrain heightmap or a sampled elevation grid from a NASA dataset.

### Step 3: Construct a terrain representation

Convert elevation values into a 3D mesh or game-engine terrain surface.

### Step 4: Derive terrain features

Calculate properties such as local slope and elevation changes from the terrain model.

### Step 5: Simulate rover traversal

Drive the simulated rover across the terrain and calculate wheel movement, body acceleration, and suspension response.

### Step 6: Generate haptic feedback

Translate the simulated physical response into vibration patterns.

## 9.4 Real terrain to physical sensation

When the rover crosses a relatively smooth region, the glove produces mild and steady vibration.

As the rover moves over uneven terrain, increased vehicle motion produces stronger, irregular feedback.

This creates a direct interaction between real-world geographical data and the glove.

**Real lunar topography → Simulated rover response → Tactile sensation**

## 9.5 Scientific limitations

The source elevation data may not resolve individual rocks or small bumps at the scale experienced by a rover.

For the hackathon, terrain-derived slopes can be combined with explicitly simulated small-scale roughness.

The presentation should distinguish between real NASA-derived topography and synthetic fine-scale details.

The system demonstrates data-driven tactile rendering, not an exact physical reconstruction of the lunar surface.

---

# 10. Grok Voice Integration

## 10.1 Purpose

Grok Voice will provide a hands-free natural-language interface for interacting with the simulation.

This is useful in the context of astronaut operations, where the user's hands may already be occupied with tools or equipment.

The feature also satisfies the required Grok API integration for the target SpaceXAI challenge, assuming the working project uses the official API.

## 10.2 Proposed voice commands

Examples include:

**Equipment selection**

"Activate the lunar drill."

**Haptic personalization**

"Increase my drilling feedback sensitivity."

**Status inquiries**

"How fast is the rover moving?"

**Terrain information**

"What kind of terrain am I driving across?"

**Equipment switching**

"Switch to rover controls."

**Profile settings**

"Load my preferred rover configuration."

## 10.3 Voice processing pipeline

**Microphone → Grok Voice API → Command interpretation → Simulator action → Feedback**

The system captures the astronaut's spoken request.

Grok Voice interprets the request and provides structured intent information to the laptop application.

The simulator then validates the requested operation and updates its state.

Successful commands can be confirmed through spoken responses, visual indicators, or haptic pulses.

## 10.4 Recommended command architecture

Voice commands should be translated into a small set of supported software actions.

Examples:

- `ACTIVATE_TOOL`
- `SELECT_ROVER`
- `SET_HAPTIC_SENSITIVITY`
- `GET_EQUIPMENT_STATUS`
- `GET_TERRAIN_STATUS`

The voice model should not directly generate arbitrary motor-control instructions or unrestricted simulator actions.

Instead, recognized intents should pass through a deterministic command handler.

This makes the integration easier to test and improves reliability.

## 10.5 Example interaction

The astronaut is operating the simulated rover.

They ask:

"How rough is the terrain ahead?"

The system retrieves terrain information from the current simulation and responds with a short assessment.

The astronaut then says:

"Increase terrain feedback sensitivity."

The simulator updates the user's haptic profile, and the glove provides a short confirmation pulse.

The user continues driving and experiences the updated terrain feedback.

## 10.6 Implementation priority

For the challenge submission, a minimal working Grok Voice integration should be prioritized over advanced dialogue.

The first version only needs to support a few reliable commands that meaningfully interact with the simulation.

The user should still be able to operate the system without voice if network access or the API becomes unavailable.

---

# 11. Software Modules

The following modules should be implemented independently.

| Module | Responsibility |
|---|---|
| Hand Tracking | Estimate hand and finger positions |
| Tracking Receiver | Receive smartphone data |
| Simulation Engine | Render lunar world and interactive equipment |
| NFC Manager | Read tag identifiers and retrieve profiles |
| Profile Manager | Store settings and equipment mappings |
| Haptic Engine | Translate simulation state into motor commands |
| Bluetooth Manager | Communicate with smartphone and ESP32 |
| Terrain Processor | Import and interpret NASA lunar data |
| Voice Interface | Connect to Grok Voice |
| Command Handler | Validate and execute voice commands |

The haptic engine should remain separate from the simulator's equipment logic, allowing additional tools to be added without rewriting low-level motor control.

---

# 12. HackHarvard Prize Strategy

## 12.1 Target challenge

**SpaceXAI — Make It Legendary**

The challenge emphasizes transforming real space data into an impressive project.

Its published requirements include:

- Development using Cursor
- Integration with Grok Imagine or Voice API
- Meaningful use of space data in the project concept
- Optional Grok Bot usage for bonus consideration

The sponsor's published prize is a branded Cursor mechanical keyboard for each member of the winning team.

The project should be submitted to this sponsor challenge if it satisfies the published requirements and the final submission rules.

## 12.2 Why LunarHaptics is a strong fit

LunarHaptics connects several disciplines:

- Aerospace-focused interface design
- Real scientific data
- Physical hardware
- Wearable electronics
- Human-computer interaction
- Computer vision
- Voice AI
- Real-time simulation

Most importantly, the project can demonstrate a physical consequence of processing space data.

Instead of merely displaying a lunar map, the application turns terrain information into a sensation that the user can experience.

This creates an intuitive, memorable demonstration of the challenge theme.

## 12.3 Required integrations

### Cursor development

Use Cursor as the project's primary development environment.

Possible development work includes ESP32 firmware, the simulation, Bluetooth communication, data processing, and voice API integration.

Keep project documentation and development history organized so the team can explain how Cursor was used.

### Grok API

Implement a functioning Grok Voice interaction that affects the simulator or the user's equipment settings.

A simple status request or sensitivity adjustment is sufficient to establish a meaningful integration if it genuinely uses the API.

### NASA data

Import real lunar surface data and show how it influences simulated equipment behavior.

The terrain integration should affect the rover's feedback, rather than serving only as a visual background.

### Grok Bot

If time permits, use Grok Bot for planning, collaboration, task decomposition, or development assistance.

This is an optional bonus consideration rather than a core dependency.

---

# 13. Revised Minimum Viable Product

## Priority 0 — Core functionality

- [ ] Build the vibration-enabled glove.
- [ ] Establish Bluetooth communication with ESP32.
- [ ] Control motor intensity and pulse patterns.
- [ ] Build the lunar simulation.
- [ ] Implement drill and hard/soft blocks.
- [ ] Connect drilling resistance to haptic feedback.
- [ ] Implement a controllable rover.
- [ ] Connect rover behavior to haptic feedback.
- [ ] Read the glove's NFC identifier.
- [ ] Load an equipment-specific astronaut profile.

These components are essential to demonstrate the central product.

## Priority 1 — Full concept and SpaceXAI integration

- [ ] Track the user's hand using the smartphone.
- [ ] Render the tracked hand in the simulation.
- [ ] Import an actual NASA lunar terrain dataset.
- [ ] Make terrain data influence the rover's movement or feedback.
- [ ] Connect the simulator to the Grok Voice API.
- [ ] Implement at least one working natural-language command.
- [ ] Develop and document the project using Cursor.

The Cursor and Grok requirements, along with meaningful real-space-data use, must not be omitted if targeting the sponsor challenge.

## Priority 2 — Demonstration polish

- [ ] Add multiple astronaut profiles.
- [ ] Add personalized per-motor feedback patterns.
- [ ] Improve glove ergonomics.
- [ ] Display motor output visually.
- [ ] Add terrain information overlays.
- [ ] Support additional Grok Voice commands.
- [ ] Add richer animations and simulation interactions.

## Stretch goals

- [ ] Additional tools and vehicles
- [ ] Adaptive haptic mappings
- [ ] Voice-controlled configuration editor
- [ ] Detailed material resistance modeling
- [ ] Grok Bot collaboration

---

# 14. Revised Hackathon Demonstration

The demonstration should tell a short astronaut mission story.

## Scene 1: Preparing for lunar operations

The presenter puts on the haptic glove.

The head-mounted smartphone tracks their hand, and the laptop renders the corresponding virtual hand.

The presenter explains that the glove functions as both a wearable identity interface and a tactile feedback system.

## Scene 2: Personalized drill activation

The user approaches the simulated drill and taps the glove against the NFC reader.

The laptop recognizes the glove identifier and loads the user's drill settings.

The glove delivers a confirmation pattern.

## Scene 3: Feeling different materials

The user drills into the soft block.

The glove produces a gentle hum.

The user then drills into the hard block.

The glove produces a significantly stronger, abrasive vibration.

The audience sees the difference in the simulator while the presenter feels it physically.

## Scene 4: Switching equipment

The user approaches the rover and taps the NFC reader again.

The simulator loads the rover profile.

The glove confirms the switch through haptic feedback.

This demonstrates how the same wearable can adapt to different equipment.

## Scene 5: Driving across real lunar terrain

The presenter shows a section of terrain derived from NASA lunar elevation data.

The rover drives across the surface.

As the simulated rover encounters changes in slope and roughness, the glove's vibrations respond.

This demonstrates the pipeline from real lunar information to physical feedback.

## Scene 6: Grok Voice interaction

While operating the rover, the presenter asks:

"How rough is the terrain I'm driving over?"

The Grok-powered interface retrieves information from the simulator and responds.

The presenter then says:

"Increase my terrain haptic sensitivity."

The application updates the user's profile and confirms the change.

As the rover continues across the terrain, the user feels the stronger feedback.

## Scene 7: Final takeaway

The presenter closes with:

"Today, we simulated what it might feel like to operate equipment on the Moon. But the underlying concept extends beyond this virtual world. By connecting equipment data to a personalized wearable interface, we can give astronauts another way to understand their tools and surroundings."

---

# 15. Engineering Risks

## 15.1 Bluetooth reliability

Two Bluetooth-connected devices may introduce platform-specific compatibility problems.

The team should validate smartphone-to-laptop tracking transport and laptop-to-ESP32 control separately.

If required, the phone can use a network-based fallback while the ESP32 continues to receive Bluetooth commands.

## 15.2 Real-time performance

The combined latency of hand tracking, networking, simulation, and feedback generation could affect the experience.

The system should use lightweight messages, local vision processing, and short communication paths.

## 15.3 Motor distinguishability

Different vibration patterns may feel similar.

Prioritize clearly differentiated patterns and test them with actual users.

## 15.4 NASA data resolution

Scientific elevation data may not contain the small-scale details needed for realistic rover vibration.

Use measured lunar topography for major terrain structure and distinguish synthetic fine-scale terrain effects.

## 15.5 Grok API availability

Internet connectivity or API behavior may interrupt voice commands.

The simulator should have fallback manual controls so the core hardware demonstration remains functional.

## 15.6 Scope management

The project combines embedded hardware, computer vision, 3D simulation, data processing, and AI.

The recommended integration order is:

1. Simulation-to-glove haptics
2. Drill and rover interactions
3. NFC personalization
4. NASA terrain data
5. Grok Voice
6. Full smartphone hand tracking and polish

The team can develop several of these components in parallel while defining common interfaces early.

---

# 16. Success Criteria

A successful demonstration should prove the following:

**Personalization:** A glove scan loads a recognizable user profile and affects equipment configuration.

**Hand tracking:** The virtual hand visibly responds to real movements.

**Material feedback:** The glove produces clearly distinguishable sensations for soft and hard drilling materials.

**Rover feedback:** Vehicle movement and simulated terrain conditions produce meaningful haptic responses.

**Real data integration:** At least one demonstrated rover interaction is informed by actual NASA lunar elevation data.

**Voice integration:** A spoken request using Grok Voice successfully reads or modifies simulator state.

**End-to-end operation:** The physical glove responds to events occurring inside the laptop simulation.

---

# 17. Future Applications

Although the hackathon prototype operates in a simulated environment, the architecture could eventually integrate telemetry from physical equipment.

Potential applications include:

- Astronaut training
- Lunar rover interfaces
- Robotic teleoperation
- Industrial equipment monitoring
- Hazardous-environment operations
- Remote scientific instruments
- Personalized assistive interfaces

Future versions could receive live data from drill sensors, rover suspension systems, robotic arms, or other equipment.

Such systems would require substantial additional validation before use in real aerospace environments.

---

# 18. Project Pitch

## One-line description

**LunarHaptics is a personalized astronaut glove that turns lunar equipment data into physical sensations.**

## Thirty-second pitch

Astronauts working on the Moon rely on complex equipment while wearing bulky gloves that limit their natural sense of touch.

We're building LunarHaptics, a wearable interface that lets astronauts personalize equipment controls and physically feel what their tools are experiencing.

Our glove uses haptic motors, NFC-based personalization, and computer vision to connect astronauts with an interactive lunar environment.

By incorporating real NASA terrain data and Grok Voice, we're demonstrating how astronauts could navigate lunar terrain, operate machinery, and receive personalized information through touch.

## Core innovation

LunarHaptics is not simply a vibrating glove or a virtual lunar simulation.

It is a modular system that connects:

**Astronaut identity + Equipment interaction + Real space data + AI assistance + Physical feedback**

The result is a personalized human-machine interface that can make complex equipment behavior more intuitive.

---

# 19. Official References

**HackHarvard 2026:**  
https://hhuh.io

**SpaceXAI challenge requirements:**  
https://hhuh.io/#challenges

**NASA CGI Moon Kit:**  
https://svs.gsfc.nasa.gov/4720/

**NASA Moon Trek:**  
https://trek.nasa.gov/moon/

**SpaceXAI Developer Documentation:**  
https://docs.x.ai/

---

# Final Vision

We envision a future where an astronaut can approach unfamiliar equipment, identify themselves with a single tap, automatically load their preferred settings, ask questions using natural language, and physically feel important equipment information through their glove.

Our HackHarvard prototype demonstrates this vision using a haptic glove, computer vision, NFC personalization, simulated lunar equipment, NASA terrain data, and Grok Voice.

**LunarHaptics — One glove. Every tool. Feel the Moon.**