/**
 * The relay-poke port (plans/CC-01-cloud-connect.md §1): after a roster epoch moves, Connect tells
 * the relay so that open sockets of the subject can be told to fetch the new roster. Until the
 * relay exists (CC-07.4 wires it) the port does nothing. A poke carries the product, the subject
 * and the new epoch, and never a key.
 */

export interface RelayPoke {
  product: string;
  subject: string;
  epoch: number;
}

export type RelayPokePort = (poke: RelayPoke) => Promise<void>;

const NO_POKE: RelayPokePort = async () => {};

let port: RelayPokePort = NO_POKE;

/** CC-07.4 installs the relay's port here; `null` restores the no-op. */
export function setRelayPokePort(next: RelayPokePort | null): void {
  port = next ?? NO_POKE;
}

/** Tell the relay. Total: a port that throws or rejects is ignored, a poke never fails a write. */
export async function pokeRelay(poke: RelayPoke): Promise<void> {
  try {
    await port(poke);
  } catch {
    // Bookkeeping only.
  }
}
