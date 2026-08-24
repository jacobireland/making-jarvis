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

/** A completed Agent thinking/reasoning block (afterAgentThought hook). */
export type AgentThoughtEvent = {
  type: "agent_thought";
  text: string;
  spokenText: string;
  durationMs?: number;
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
  /** What triggered this speak (final reply vs thinking block). */
  source?: string;
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
  | AgentThoughtEvent
  | UtteranceEvent
  | StateEvent
  | TtsDoneEvent;
