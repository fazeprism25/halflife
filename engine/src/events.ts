// In-process event bus for the console's live view (served as Server-Sent Events).

export type EngineEvent =
  | { type: "report"; id: string; status: string; stage?: string | null; source?: string }
  | { type: "claim"; report_id: string; claim_id: string; verdict: string | null; level: string | null }
  | { type: "cache"; report_id: string; action: string; status: string; result: string }
  | { type: "status" };

type Listener = (e: EngineEvent) => void;

export class Bus {
  private listeners = new Set<Listener>();
  emit(e: EngineEvent) {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        /* a broken listener must not affect the pipeline */
      }
    }
  }
  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  get size() {
    return this.listeners.size;
  }
}
