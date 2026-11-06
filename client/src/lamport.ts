/** Relógio lógico de Lamport do celular. */
let L = Number(localStorage.getItem('lamport') ?? 0) || 0;
const listeners = new Set<() => void>();

function save() {
  localStorage.setItem('lamport', String(L));
  listeners.forEach((l) => l());
}

export const lamport = {
  /** Evento local / envio de mensagem: L = L + 1 */
  send(): number {
    L += 1;
    save();
    return L;
  },
  /** Recebimento de mensagem: L = max(L, recebido) + 1 */
  receive(remote: number | undefined) {
    if (typeof remote !== 'number') return;
    L = Math.max(L, remote) + 1;
    save();
  },
  get value() {
    return L;
  },
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
