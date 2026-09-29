import { useEffect, useRef, type ReactNode } from "react";

export interface ModalDialogProps {
  readonly titleId: string;
  readonly className: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

export function ModalDialog({ titleId, className, onClose, children }: ModalDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    return () => { if (dialog.open) dialog.close(); };
  }, []);

  return <dialog
    ref={dialogRef}
    className="workspace-dialog-scrim"
    aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
  >
    <section className={className}>{children}</section>
  </dialog>;
}
