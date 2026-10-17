"""LunarHaptics hub application: wires engine, glove, NFC, mission state, voice, patches and assistant.

WebSockets:  /ws/sim (simulator, 1+ clients)   /ws/tracker (phone hand tracker)
REST:        /api/health  /api/voice/token  /api/voice/config  /api/profiles  /api/nfc/scan
             /api/patches/{profile_id}  /api/assistant/ask        static: /patches/*
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError

from .assistant.client import AssistantClient
from .assistant.context import build_context
from .assistant.triggers import AutoCoach
from .commands.handler import CommandHandler
from .glove.transport import GloveTransport, make_transport
from .haptics import patterns
from .haptics.engine import HapticEngine, OutputCalibration
from .imagine.patches import PatchError, PatchService
from .mission.state import MissionState, Outcome
from .nfc.service import NfcService
from .profiles.store import ProfileStore, SettingError
from .protocol.messages import SimEvent, SimState, UiAction, VoiceToolCall
from .terrain import TerrainGrid
from .voice import local_intents
from .voice.session import session_config
from .voice.token import VoiceTokenError, mint_token

log = logging.getLogger("lunarhub")

TICK_HZ = 100
SEND_EVERY = 2  # 50 Hz glove frames
MOTORS_EVERY = 5  # 20 Hz motor broadcast
COACH_EVERY = 10  # 10 Hz auto-coach check
FRAME_TTL_MS = 150
KEEPALIVE_S = 0.1
STOP_TIMEOUT_S = 2.0


@dataclass
class Settings:
    root: Path
    glove: str = "null"
    nfc: str = "auto"
    terrain_site: str = "site04"
    assistant: str = "local"  # local | chalk
    variant: str = "v2+guard"
    xai_api_key: str = ""
    imagine_model: str = "grok-imagine-image"
    voice_model: str = "grok-voice-latest"
    voice_name: str = "eve"
    seed: int = 0
    log_telemetry: bool = False
    pregenerate_patches: bool = True

    @property
    def data_dir(self) -> Path:
        return self.root / "data"


class Hub:
    def __init__(self, settings: Settings, transport: GloveTransport | None = None) -> None:
        self.settings = settings
        self.store = ProfileStore(settings.data_dir / "profiles.json")
        self.mission = MissionState(self.store)
        self.engine = HapticEngine(seed=settings.seed, calibration=self._load_calibration())
        self.terrain = TerrainGrid.try_load(settings.root / "sim" / "public" / "terrain" / settings.terrain_site)
        self.transport = transport or make_transport(settings.glove)
        self.nfc = NfcService(settings.nfc, self.on_nfc_uid)
        self.patches = PatchService(settings.data_dir, settings.xai_api_key, settings.imagine_model)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        self.assistant = AssistantClient(settings.assistant, settings.variant,
                                         settings.data_dir / "sessions" / f"assistant-{stamp}.jsonl")
        self.telemetry_path = settings.data_dir / "sessions" / f"telemetry-{stamp}.jsonl" \
            if settings.log_telemetry else None
        self.coach = AutoCoach()
        self.commands = CommandHandler(self)
        self.sims: set[WebSocket] = set()
        self.trackers: set[WebSocket] = set()
        self.tracker_fps = 0.0
        self.tracker_engine = ""  # "mediapipe" (on the phone) | "anyhand" (laptop GPU)
        self._tracker_last = 0.0
        self._last_state_json = ""
        self._last_motor_send = 0.0
        self._last_duty: list[int] = [0] * 5
        self._assistant_seq = 0
        self._assistant_task: asyncio.Task | None = None
        self._tasks: list[asyncio.Task] = []
        self._glove_task: asyncio.Task | None = None
        self._stopping = False
        self._telemetry_last = 0.0

    def _load_calibration(self) -> OutputCalibration:
        path = self.settings.data_dir / "glove_calibration.json"
        if path.exists():
            data = json.loads(path.read_text())
            return OutputCalibration(min_duty=data.get("min_duty", [70] * 5), max_duty=data.get("max_duty", 180))
        return OutputCalibration()

    # ================================================================ lifecycle
    async def start(self) -> None:
        if self.settings.xai_api_key:
            log.info("XAI_API_KEY loaded: Grok Voice (%s) and patches enabled", self.settings.voice_model)
        else:
            log.warning("XAI_API_KEY not set in .env: Grok Voice and patch generation disabled")
        self.sync_engine()
        loop = asyncio.get_running_loop()
        self._glove_task = loop.create_task(self._supervise("glove", self.transport.run))
        self._tasks = [loop.create_task(self._supervise(name, fn)) for name, fn in [
            ("nfc", self.nfc.run), ("haptics", self._haptic_loop), ("state", self._state_loop),
        ]]
        if self.settings.pregenerate_patches and self.settings.xai_api_key:
            self._tasks.append(loop.create_task(self._pregenerate_patches()))

    async def stop(self) -> None:
        """Motors off, then shut down. Runs once: __main__ calls it as soon as the server starts shutting down."""
        if self._stopping:
            return
        self._stopping = True
        for t in self._tasks:  # the haptic loop first, so no frame can follow the stop
            t.cancel()
        try:
            await asyncio.wait_for(self.transport.send_stop(), STOP_TIMEOUT_S)
        except TimeoutError:
            log.warning("glove did not take the stop within %.0f s", STOP_TIMEOUT_S)
        if self._glove_task is not None:
            self._glove_task.cancel()

    async def _supervise(self, name: str, fn) -> None:
        delay = 1.0
        while True:
            try:
                await fn()
                return
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("task %s crashed; restarting in %.0fs", name, delay)
                await asyncio.sleep(delay)
                delay = min(delay * 2, 10.0)

    # ================================================================ loops
    async def _haptic_loop(self) -> None:
        loop = asyncio.get_running_loop()
        dt = 1.0 / TICK_HZ
        next_t = loop.time()
        tick = 0
        while True:
            out = self.engine.tick(dt)
            tick += 1
            if tick % SEND_EVERY == 0:
                now = loop.time()
                if out.duty != self._last_duty or now - self._last_motor_send > KEEPALIVE_S:
                    await self.transport.send_frame(out.duty, FRAME_TTL_MS)
                    self._last_duty, self._last_motor_send = list(out.duty), now
            if tick % MOTORS_EVERY == 0 and self.sims:
                await self.broadcast({"t": "hub.motors", "duty": out.duty,
                                      "levels": [round(float(x), 3) for x in out.levels],
                                      "dominant": out.dominant, "alert": out.alert_active})
            if tick % COACH_EVERY == 0:
                self._check_coach(loop.time())
            next_t += dt
            delay = next_t - loop.time()
            if delay < -0.25:  # fell badly behind (e.g. laptop suspended): resync instead of bursting
                next_t = loop.time()
            await asyncio.sleep(max(0.0, delay))

    async def _state_loop(self) -> None:
        while True:
            await self.broadcast_state()
            await asyncio.sleep(0.1)

    def _check_coach(self, now: float) -> None:
        if self.mission.profile is None:
            return
        snap_alerts = [(e.id, e.meaning) for e in self.engine.recent
                       if e.layer == "alert" and self.engine.t - e.t <= 4.0]
        in_use = self.mission.active_equipment if self.engine.state.mode == self.mission.active_equipment else None
        label = self.coach.check(now, self.engine.last_output.dominant, snap_alerts, in_use)
        if label and (self._assistant_task is None or self._assistant_task.done()):
            self._assistant_task = asyncio.get_running_loop().create_task(self.ask_assistant("", label))

    # ================================================================ state & broadcast
    def sync_engine(self) -> None:
        profile = self.mission.profile
        self.engine.set_profile(profile.to_shaping() if profile else None)
        self.engine.set_active_equipment(self.mission.active_equipment)

    def state_view(self) -> dict:
        view = self.mission.view()
        if view["profile"] is not None:
            url, source = self.patches.url(self.mission.profile)
            view["profile"]["patch_url"], view["profile"]["patch_source"] = url, source
        view["nfc"].update(self.nfc.view())
        return {
            "t": "hub.state",
            **view,
            "glove": self.transport.view(),
            "tracker": {"connected": bool(self.trackers), "fps": round(self.tracker_fps, 1),
                        "engine": self.tracker_engine},
            "voice": {"configured": bool(self.settings.xai_api_key), "model": self.settings.voice_model},
            "assistant": {"backend": self.settings.assistant, "variant": self.settings.variant,
                          "auto": self.coach.enabled, "last_error": self.assistant.last_error},
            "profiles": [{"id": p.id, "name": p.name, "callsign": p.callsign, "has_tag": bool(p.uids)}
                         for p in self.store.profiles],
        }

    async def broadcast_state(self, force: bool = False) -> None:
        if not self.sims:
            return
        msg = json.dumps(self.state_view())
        if force or msg != self._last_state_json:
            self._last_state_json = msg
            await self._send_all(msg)

    async def broadcast(self, payload: dict) -> None:
        if self.sims:
            await self._send_all(json.dumps(payload))

    async def _send_all(self, text: str) -> None:
        dead = []
        for ws in list(self.sims):
            try:
                await ws.send_text(text)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.sims.discard(ws)

    async def toast(self, level: str, text: str) -> None:
        await self.broadcast({"t": "hub.toast", "level": level, "text": text})

    # ================================================================ HubContext (used by CommandHandler)
    async def apply_outcome(self, outcome: Outcome) -> None:
        for pattern, cause in outcome.patterns:
            self.engine.play(pattern, cause)
        if outcome.profile_changed:
            self.coach.reset()
        if outcome.profile_changed or outcome.equipment_changed:
            self.sync_engine()
        for level, text in outcome.toasts:
            await self.toast(level, text)
        if outcome.welcome and self.mission.profile is not None:
            p = self.mission.profile
            url, source = self.patches.url(p)
            await self.broadcast({"t": "hub.welcome", "profile_id": p.id, "name": p.name, "callsign": p.callsign,
                                  "patch_url": url, "patch_source": source})
        await self.broadcast_state(force=True)

    async def profile_settings_changed(self) -> None:
        self.sync_engine()
        await self.broadcast_state(force=True)

    async def ask_assistant(self, question: str, trigger: str) -> dict:
        self._assistant_seq += 1
        aid = f"a-{self._assistant_seq}"
        await self.broadcast({"t": "hub.assistant", "id": aid, "status": "thinking", "trigger": trigger,
                              "question": question})
        ctx = build_context(self.mission, self.engine, self.terrain)
        result = await self.assistant.ask(ctx, question, trigger)
        await self.broadcast({"t": "hub.assistant", "id": aid, "status": "ready", "trigger": trigger,
                              "question": question, "advice": result.advice.model_dump(),
                              "latency_ms": result.latency_ms, "source": result.source, "variant": result.variant})
        return {**result.advice.model_dump(), "source": result.source}

    async def redesign_patch(self, style: str) -> dict:
        profile = self.mission.profile
        if profile is None:
            return {"ok": False, "error": "no_profile"}

        async def job() -> None:
            try:
                await self.patches.generate(profile, style)
                url, source = self.patches.url(profile)
                await self.broadcast({"t": "hub.patch", "profile_id": profile.id, "url": url, "source": source})
                await self.toast("ok", f"New mission patch for {profile.name}")
                await self.broadcast_state(force=True)
            except PatchError as exc:
                await self.toast("warn", f"Patch generation failed: {exc}")

        asyncio.get_running_loop().create_task(job())
        return {"ok": True, "status": "generating", "note": "the new patch appears on the HUD in a few seconds"}

    async def _pregenerate_patches(self) -> None:
        for profile in list(self.store.profiles):
            try:
                if await self.patches.ensure(profile):
                    await self.broadcast_state(force=True)
            except PatchError as exc:
                log.warning("patch pre-generation for %s failed: %s", profile.id, exc)

    # ================================================================ inputs
    def on_nfc_uid(self, uid: str) -> None:
        asyncio.get_running_loop().create_task(self.apply_outcome(self.mission.on_scan(uid)))

    def simulate_scan(self, profile_id: str | None) -> Outcome:
        profile = self.store.get(profile_id) if profile_id else (self.mission.profile or self.store.profiles[0])
        if profile is None:
            return Outcome(ok=False, toasts=[("error", f"no profile '{profile_id}'")])
        self.mission.last_uid = "keyboard"
        return self.mission.identify(profile)

    async def handle_sim_message(self, ws: WebSocket, raw: str) -> None:
        try:
            msg = json.loads(raw)
            kind = msg.get("t")
            if kind == "sim.state":
                state = SimState.model_validate(msg)
                self.engine.update_state(state)
                if state.near != self.mission.near:
                    self.mission.set_near(state.near)
                    await self.broadcast_state()
                self._log_telemetry(msg)
            elif kind == "sim.event":
                self.engine.on_event(SimEvent.model_validate(msg))
            elif kind == "ui.action":
                await self.handle_action(UiAction.model_validate(msg))
            elif kind == "voice.tool_call":
                call = VoiceToolCall.model_validate(msg)
                output = await self.commands.execute(call.name, call.args)
                log.info("tool %s(%s) -> %s", call.name, call.args, output)
                await ws.send_text(json.dumps({"t": "voice.tool_result", "call_id": call.call_id, "output": output}))
            elif kind == "voice.transcript":
                log.info("voice %s: %s", msg.get("role"), msg.get("text"))
        except (ValidationError, json.JSONDecodeError) as exc:
            log.warning("bad sim message: %s", str(exc)[:300])

    async def handle_action(self, a: UiAction) -> None:
        args = a.args
        if a.action == "nfc_simulate":
            await self.apply_outcome(self.simulate_scan(args.get("profile_id")))
        elif a.action == "select_equipment":
            await self.apply_outcome(self.mission.request_equipment(args.get("equipment")))
        elif a.action == "enroll":
            await self.apply_outcome(self.mission.enroll(str(args.get("profile_id"))))
        elif a.action == "logout":
            await self.apply_outcome(self.mission.logout())
        elif a.action == "set_setting":
            profile = self.mission.profile
            if profile is None:
                await self.toast("warn", "Identify yourself first (tap glove)")
                return
            try:
                old, new = self.store.set_setting(profile.id, args["equipment"], args["setting"], float(args["value"]))
            except (SettingError, KeyError, ValueError) as exc:
                await self.toast("error", str(exc))
                return
            await self.profile_settings_changed()
            await self.apply_outcome(Outcome(patterns=[(patterns.setting_up() if new >= old else
                                                        patterns.setting_down(), "setting changed in UI")]))
        elif a.action == "calibrate_hand":
            profile = self.mission.profile
            if profile is not None:
                profile.hand_calibration = args.get("calibration")
                self.store.save()
                await self.toast("ok", f"Hand calibration saved for {profile.name}")
        elif a.action == "ask_assistant":
            if self._assistant_task is None or self._assistant_task.done():
                self._assistant_task = asyncio.get_running_loop().create_task(
                    self.ask_assistant(str(args.get("question", ""))[:500], "manual"))
        elif a.action == "assistant_auto":
            self.coach.enabled = bool(args.get("enabled", True))
            await self.broadcast_state(force=True)
        elif a.action == "regenerate_patch":
            result = await self.redesign_patch(str(args.get("style", ""))[:120])
            if not result.get("ok"):
                await self.toast("warn", "Identify yourself first (tap glove)")
        elif a.action == "play_pattern":
            factory = patterns.TEST_PATTERNS.get(str(args.get("name")))
            if factory:
                self.engine.play(factory(), "UI test")
        elif a.action == "stop":
            self.engine.stop_all()
        elif a.action == "local_command":  # Grok offline: typed command -> same tools, spoken by the browser
            text = str(args.get("text", ""))[:300]
            intents = local_intents.parse(text)
            if not intents:
                await self.broadcast({"t": "voice.local_reply", "text": "Sorry, I can't do that offline."})
                return
            tool, tool_args = intents[0]
            output = await self.commands.execute(tool, tool_args)
            await self.broadcast({"t": "voice.local_reply", "tool": tool, "output": output,
                                  "text": local_intents.summarize(tool, output)})
        else:
            log.warning("unknown ui.action %s", a.action)

    def _log_telemetry(self, msg: dict) -> None:
        if self.telemetry_path is None:
            return
        now = time.time()
        if now - self._telemetry_last < 0.1:
            return
        self._telemetry_last = now
        self.telemetry_path.parent.mkdir(parents=True, exist_ok=True)
        with self.telemetry_path.open("a") as fh:
            fh.write(json.dumps({"ts": now, "state": msg, "haptics": self.engine.snapshot(),
                                 "profile_id": self.mission.profile_id,
                                 "active_equipment": self.mission.active_equipment}) + "\n")

    def on_tracker_frame(self, engine: str = "") -> None:
        self.tracker_engine = engine
        now = time.monotonic()
        if self._tracker_last:
            inst = 1.0 / max(1e-3, now - self._tracker_last)
            self.tracker_fps = 0.9 * self.tracker_fps + 0.1 * inst
        self._tracker_last = now


def create_app(settings: Settings, transport: GloveTransport | None = None) -> FastAPI:
    hub = Hub(settings, transport)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await hub.start()
        yield
        await hub.stop()

    app = FastAPI(title="LunarHaptics hub", lifespan=lifespan)
    app.state.hub = hub

    @app.websocket("/ws/sim")
    async def ws_sim(ws: WebSocket):
        await ws.accept()
        hub.sims.add(ws)
        await ws.send_text(json.dumps(hub.state_view()))
        try:
            while True:
                await hub.handle_sim_message(ws, await ws.receive_text())
        except WebSocketDisconnect:
            pass
        finally:
            hub.sims.discard(ws)

    @app.websocket("/ws/tracker")
    async def ws_tracker(ws: WebSocket):
        await ws.accept()
        hub.trackers.add(ws)
        await hub.broadcast_state(force=True)
        try:
            while True:
                raw = await ws.receive_text()
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if msg.get("t") == "ping":
                    await ws.send_text(json.dumps({"t": "pong", "ts": msg.get("ts")}))
                elif msg.get("t") == "hand.frame":
                    hub.on_tracker_frame(str(msg.get("engine", "mediapipe"))[:20])
                    await hub._send_all(raw)  # relay verbatim to every sim
        except WebSocketDisconnect:
            pass
        finally:
            hub.trackers.discard(ws)
            hub.tracker_fps = 0.0
            await hub.broadcast_state(force=True)

    @app.get("/api/health")
    async def health():
        return {"glove": hub.transport.view(), "nfc": hub.nfc.view(), "terrain": hub.terrain is not None,
                "voice_configured": bool(settings.xai_api_key), "assistant": settings.assistant,
                "assistant_error": hub.assistant.last_error, "sims": len(hub.sims), "trackers": len(hub.trackers),
                "profile": hub.mission.profile_id}

    @app.post("/api/voice/token")
    async def voice_token():
        try:
            return await mint_token(settings.xai_api_key)
        except VoiceTokenError as exc:
            raise HTTPException(503, str(exc)) from exc

    @app.get("/api/voice/config")
    async def voice_config():
        return session_config(settings.voice_model, settings.voice_name)

    @app.get("/api/profiles")
    async def profiles():
        return [p.model_dump(by_alias=True, mode="json") for p in hub.store.profiles]

    @app.post("/api/nfc/scan")
    async def nfc_scan(body: dict):
        uid = str(body.get("uid", "")).strip()
        if not uid:
            raise HTTPException(400, "uid required")
        hub.nfc.emit(uid)
        return {"ok": True}

    @app.post("/api/patches/{profile_id}")
    async def regenerate_patch(profile_id: str, body: dict | None = None):
        profile = hub.store.get(profile_id)
        if profile is None:
            raise HTTPException(404, "no such profile")
        try:
            await hub.patches.generate(profile, (body or {}).get("style", ""))
        except PatchError as exc:
            raise HTTPException(503, str(exc)) from exc
        await hub.broadcast_state(force=True)
        return {"ok": True, "url": hub.patches.url(profile)[0]}

    @app.post("/api/assistant/ask")
    async def assistant_ask(body: dict | None = None):
        return await hub.ask_assistant(str((body or {}).get("question", ""))[:500], "api")

    app.mount("/patches", StaticFiles(directory=settings.data_dir / "patches", check_dir=False), name="patches")
    return app
