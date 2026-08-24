export type VoiceCursorState =
  | "idle"
  | "listening"
  | "transcribing"
  | "waiting_agent"
  | "speaking"
  | "paused"
  | "error";

export type AgentResponseEvent = {
  type: "agent_response";
  text: string;
  spokenText: string;
  conversationId?: string;
  generationId?: string;
  receivedAt: string;
  raw?: unknown;
};

export type UtteranceEvent = {
  type: "utterance";
  text: string;
  receivedAt: string;
};

export type StateEvent = {
  type: "state";
  state: VoiceCursorState;
  detail?: string;
  at: string;
};

export type TtsDoneEvent = {
  type: "tts_done";
  ok: boolean;
  engine?: string;
  voice?: string;
  /** Ms from speak start until first audio playback begins (synth of first chunk). */
  firstAudioMs?: number;
  /** Ms for full synth+playback wall time. */
  totalMs?: number;
  error?: string;
  at: string;
};

export type HealthResponse = {
  ok: true;
  service: "voice-cursor";
  version: string;
  state: VoiceCursorState;
  lastAgentResponseAt?: string;
  eventCount: number;
};

export type VoiceCursorEvent =
  | AgentResponseEvent
  | UtteranceEvent
  | StateEvent
  | TtsDoneEvent;
