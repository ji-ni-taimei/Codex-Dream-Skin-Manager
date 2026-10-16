import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

export function ConfirmationDialog({ title, onCancel, children }: { title: string; onCancel(): void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} className="confirmation-dialog" aria-label={title} onCancel={event => { event.preventDefault(); onCancel(); }}>
    {children}
  </dialog>;
}
