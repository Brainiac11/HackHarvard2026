// Mirrors hub/lunarhub/protocol/messages.py and the hub.* payloads in hub/lunarhub/app.py.

export type Equipment = "drill" | "rover";
export type Mode = "walk" | "drill" | "rover";

export interface Wheel { comp: number; vel: number; contact: boolean }

export interface SimStateMsg {
  t: "sim.state";
  ts: number;
  mode: Mode;
  near: Equipment | null;
  drill: {
    held: boolean; trigger: number; target: "soft" | "hard" | null; contact: boolean;
    hardness: number; depth_m: number; rate_mps: number; stalled: boolean;
  };
  rover: {
    speed: number; accel: number; throttle: number; steer: number; wheels: Wheel[];
    rough: number; pitch_deg: number; roll_deg: number; heading_deg: number;
  };
  terrain: {
    x: number; z: number; elev_m: number; lat: number | null; lon: number | null;
    lola_slope_deg: number | null; lola_slope_err_deg: number | null; coverage: number | null;
    synthetic_detail: boolean;
  };
}

export interface SimEventMsg { t: "sim.event"; name: "impact" | "breakthrough" | "stall" | "enter_rover" | "exit_rover"; mag: number; side?: "left" | "right" }

export interface ProfileSummary {
  id: string; name: string; callsign: string; auth_pattern: string;
  settings: {
    drill: { sensitivity: number; mapping: string };
    rover: { vibration: number; terrain_sensitivity: number; mapping: string; slope_warn_deg: number };
    warning_intensity: number; gain: number;
  };
  patch_url?: string; patch_source?: string;
  hand_calibration?: { open: number[]; closed: number[] } | null; // saved with K (curl range in the glove)
}

export interface HubState {
  t: "hub.state";
  profile: ProfileSummary | null;
  equipment: { active: Equipment | null; authorized: Equipment[]; near: Equipment | null };
  nfc: { last_uid: string | null; unknown_uid: string | null; backend: string; reader: string; error: string };
  glove: { transport: string; connected: boolean; rtt_ms: number | null; detail: string };
  tracker: { connected: boolean; fps: number; engine: string };
  voice: { configured: boolean; model: string };
  assistant: { backend: string; variant: string; auto: boolean; last_error: string };
  profiles: { id: string; name: string; callsign: string; has_tag: boolean }[];
}

export interface HubMotors { t: "hub.motors"; duty: number[]; levels: number[]; dominant: string | null; alert: boolean }
export interface HubToast { t: "hub.toast"; level: "info" | "ok" | "warn" | "error"; text: string }
export interface HubWelcome { t: "hub.welcome"; profile_id: string; name: string; callsign: string; patch_url: string; patch_source: string }
export interface HubPatch { t: "hub.patch"; profile_id: string; url: string; source: string }

export interface AssistantAdvice {
  feeling: string; explanation: string; action: string; hazard: "nominal" | "caution" | "warning";
  cited_values: { name: string; value: number }[]; data_quality_note: string | null;
}
export interface HubAssistant {
  t: "hub.assistant"; id: string; status: "thinking" | "ready" | "error"; trigger: string; question?: string;
  advice?: AssistantAdvice; latency_ms?: number; source?: string; variant?: string;
}

export interface HandFrame { t: "hand.frame"; ts: number; hand: string; score: number; lm: number[][]; wlm: number[][]; fps: number }
export interface VoiceToolResult { t: "voice.tool_result"; call_id: string; output: Record<string, unknown> }

export interface VoiceLocalReply { t: "voice.local_reply"; text: string; tool?: string; output?: Record<string, unknown> }

export type HubMessage = HubState | HubMotors | HubToast | HubWelcome | HubPatch | HubAssistant | HandFrame | VoiceToolResult
  | VoiceLocalReply;
