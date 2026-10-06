/**
 * Browser generated notification tones.
 *
 * The monitor deliberately creates short tones with the Web Audio API instead
 * of loading an audio file.  This keeps the bundle small and avoids any
 * external media request.
 */
export type AudioCue = 'earthquake' | 'shake' | 'eew' | 'cancel';

export type AudioNotifyResult =
  | 'queued'
  | 'suppressed'
  | 'disabled'
  | 'waiting'
  | 'sandbox-locked'
  | 'unavailable';

export type AudioNotifierStatus = 'off' | 'waiting' | 'enabled' | 'sandbox-locked' | 'unavailable';

interface AudioNote {
  frequency: number;
  offset: number;
  duration: number;
}

interface AudioCueDefinition {
  priority: number;
  duration: number;
  notes: readonly AudioNote[];
}

const CUE_DEFINITIONS: Record<AudioCue, AudioCueDefinition> = {
  // Short, original tones.  They are intentionally not modeled on official
  // EEW/J-alert sounds.
  earthquake: {
    priority: 1,
    duration: 0.28,
    notes: [
      { frequency: 520, offset: 0, duration: 0.11 },
      { frequency: 700, offset: 0.13, duration: 0.11 },
    ],
  },
  shake: {
    priority: 2,
    duration: 0.34,
    notes: [
      { frequency: 430, offset: 0, duration: 0.09 },
      { frequency: 560, offset: 0.11, duration: 0.09 },
      { frequency: 680, offset: 0.22, duration: 0.09 },
    ],
  },
  eew: {
    priority: 3,
    duration: 0.42,
    notes: [
      { frequency: 880, offset: 0, duration: 0.1 },
      { frequency: 660, offset: 0.13, duration: 0.1 },
      { frequency: 880, offset: 0.26, duration: 0.1 },
    ],
  },
  cancel: {
    priority: 1,
    duration: 0.24,
    notes: [
      { frequency: 480, offset: 0, duration: 0.1 },
      { frequency: 360, offset: 0.12, duration: 0.09 },
    ],
  },
};

interface ActiveNode {
  oscillator: OscillatorNode;
  envelope: GainNode;
}

interface WindowWithAudioContext {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
}

export class AudioNotifier {
  private readonly sandbox: boolean;
  private sandboxUnlocked = false;
  private enabled = false;
  private volume = 0.5;
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private contextUnavailable = false;
  private queue: AudioCue[] = [];
  private activeCue: AudioCue | null = null;
  private activeNodes: ActiveNode[] = [];
  private finishTimer: number | undefined;

  constructor(sandbox: boolean) {
    this.sandbox = sandbox;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.clearPending();
    this.updateGain();
  }

  setVolume(percent: number): void {
    const safePercent = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 50;
    this.volume = safePercent / 100;
    this.updateGain();
  }

  isSandboxUnlocked(): boolean {
    return !this.sandbox || this.sandboxUnlocked;
  }

  status(): AudioNotifierStatus {
    if (!this.enabled) return 'off';
    if (this.sandbox && !this.sandboxUnlocked) return 'sandbox-locked';
    if (this.contextUnavailable) return 'unavailable';
    if (!this.context || this.context.state === 'suspended') return 'waiting';
    return this.context.state === 'running' ? 'enabled' : 'unavailable';
  }

  /** Resume/create the single AudioContext from a user gesture. */
  async activateFromGesture(allowSandbox = false): Promise<boolean> {
    if (!this.enabled) return false;
    if (this.sandbox && allowSandbox) this.sandboxUnlocked = true;
    if (this.sandbox && !this.sandboxUnlocked) return false;

    const context = this.ensureContext();
    if (!context) return false;
    try {
      if (context.state === 'suspended') await context.resume();
    } catch {
      return false;
    }
    try {
      this.updateGain();
      this.drainQueue();
    } catch {
      this.clearPending();
      return false;
    }
    return context.state === 'running';
  }

  /** Play a manually requested test tone after the current click unlocks audio. */
  async playTestCue(cue: AudioCue): Promise<AudioNotifyResult> {
    if (!this.enabled) return 'disabled';
    if (this.sandbox && !this.sandboxUnlocked) return 'sandbox-locked';
    if (!(await this.activateFromGesture())) return this.statusToResult();
    try {
      return this.enqueue(cue);
    } catch {
      this.clearPending();
      return 'unavailable';
    }
  }

  /** Queue a notification received from the normal data path. */
  notify(cue: AudioCue): AudioNotifyResult {
    if (!this.enabled) return 'disabled';
    if (this.sandbox && !this.sandboxUnlocked) return 'sandbox-locked';
    if (!this.context || this.context.state !== 'running') return 'waiting';
    try {
      return this.enqueue(cue);
    } catch {
      this.clearPending();
      return 'unavailable';
    }
  }

  clearPending(): void {
    this.queue.length = 0;
    this.stopActiveCue();
  }

  dispose(): void {
    this.clearPending();
    const context = this.context;
    this.context = null;
    this.gain = null;
    if (context) void context.close().catch(() => undefined);
  }

  private statusToResult(): AudioNotifyResult {
    const current = this.status();
    if (current === 'sandbox-locked') return 'sandbox-locked';
    if (current === 'unavailable') return 'unavailable';
    if (current === 'waiting') return 'waiting';
    return 'disabled';
  }

  private ensureContext(): AudioContext | null {
    if (this.context) return this.context;
    const audioWindow = window as unknown as WindowWithAudioContext;
    const AudioContextConstructor = audioWindow.AudioContext ?? audioWindow.webkitAudioContext;
    if (!AudioContextConstructor) {
      this.contextUnavailable = true;
      return null;
    }
    try {
      const context = new AudioContextConstructor();
      this.context = context;
      this.gain = context.createGain();
      this.gain.connect(context.destination);
      this.updateGain();
      return this.context;
    } catch {
      this.contextUnavailable = true;
      this.context = null;
      this.gain = null;
      return null;
    }
  }

  private updateGain(): void {
    if (!this.gain || !this.context) return;
    try {
      this.gain.gain.setTargetAtTime(this.enabled ? this.volume : 0, this.context.currentTime, 0.01);
    } catch {
      // Audio failures must not affect earthquake rendering.
    }
  }

  private enqueue(cue: AudioCue): AudioNotifyResult {
    if (this.activeCue === cue || this.queue.includes(cue)) return 'suppressed';
    const definition = CUE_DEFINITIONS[cue];
    if (cue === 'eew') {
      // EEW has the highest priority.  Older, lower-priority queued tones are
      // discarded so a warning is not buried under routine notifications.
      this.queue = this.queue.filter((queued) => CUE_DEFINITIONS[queued].priority >= definition.priority);
    }
    this.queue.push(cue);
    this.queue.sort((left, right) => CUE_DEFINITIONS[right].priority - CUE_DEFINITIONS[left].priority);
    this.drainQueue();
    return 'queued';
  }

  private drainQueue(): void {
    if (this.activeCue || this.queue.length === 0 || !this.context || this.context.state !== 'running' || !this.gain) return;
    const cue = this.queue.shift();
    if (!cue) return;
    const definition = CUE_DEFINITIONS[cue];
    this.activeCue = cue;
    const context = this.context;
    const start = context.currentTime + 0.01;
    for (const note of definition.notes) {
      const oscillator = context.createOscillator();
      const envelope = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(note.frequency, start + note.offset);
      envelope.gain.setValueAtTime(0.001, start + note.offset);
      envelope.gain.linearRampToValueAtTime(0.12, start + note.offset + 0.015);
      envelope.gain.exponentialRampToValueAtTime(0.001, start + note.offset + note.duration);
      oscillator.connect(envelope).connect(this.gain);
      oscillator.addEventListener('ended', () => {
        try {
          oscillator.disconnect();
          envelope.disconnect();
        } catch {
          // Nodes may already have been disconnected during page teardown.
        }
      }, { once: true });
      this.activeNodes.push({ oscillator, envelope });
      oscillator.start(start + note.offset);
      oscillator.stop(start + note.offset + note.duration + 0.02);
    }
    this.finishTimer = window.setTimeout(() => {
      this.finishTimer = undefined;
      this.activeCue = null;
      this.activeNodes = [];
      this.drainQueue();
    }, (definition.duration + 0.08) * 1000);
  }

  private stopActiveCue(): void {
    if (this.finishTimer !== undefined) window.clearTimeout(this.finishTimer);
    this.finishTimer = undefined;
    for (const node of this.activeNodes) {
      try {
        node.oscillator.stop();
        node.oscillator.disconnect();
        node.envelope.disconnect();
      } catch {
        // An oscillator that already ended cannot be stopped twice.
      }
    }
    this.activeNodes = [];
    this.activeCue = null;
  }
}
