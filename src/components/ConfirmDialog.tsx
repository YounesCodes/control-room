import { useEffect, useRef, type ReactNode } from "react";
import { Modal } from "./Modal";

interface ConfirmDialogProps {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => confirmRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <Modal title={title} onClose={onClose}>
      <div className="form-stack">
        <p className="modal-copy">{message}</p>
        <footer className="modal-actions">
          <button className="secondary-button" type="button" onClick={onClose}>
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            className={danger ? "danger-button" : "primary-button"}
            type="button"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </footer>
      </div>
    </Modal>
  );
}
