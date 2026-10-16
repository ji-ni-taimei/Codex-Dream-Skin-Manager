import type { UpdateCheck } from "../../contracts/manager.mjs";

// Private approval binding includes channel/key/package identity; never a URL
// or installation path supplied by the page.
export interface UpdateCandidate extends Omit<UpdateCheck, "handle" | "expiresAt" | "updateAvailable"> { binding: string }
export interface UpdatePort {
  check(): Promise<UpdateCandidate>;
  install(candidate: UpdateCandidate, operationId: string): Promise<{ managerMustQuit: boolean }>;
  receipt(id: string): Promise<"installed" | "failed" | null>;
}
