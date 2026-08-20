import type { ReactNode } from "react";
import { X } from "lucide-react";

interface ModalProps {
  title: string;
  children: ReactNode;
  onClose: () => void;
  width?: "normal" | "wide";
}

export function Modal({ title, children, onClose, width = "normal" }: ModalProps) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className={`modal modal-${width}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <h2 id="modal-title">{title}</h2>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close">
            <X size={17} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
