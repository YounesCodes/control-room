import { useEffect, useRef, useState, type FormEvent } from "react";
import { Modal } from "./Modal";

interface PromptDialogProps {
  title: string;
  label: string;
  description?: string;
  defaultValue?: string;
  placeholder?: string;
  submitLabel?: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}

export function PromptDialog({
  title,
  label,
  description,
  defaultValue = "",
  placeholder,
  submitLabel = "Save",
  onSubmit,
  onClose,
}: PromptDialogProps) {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus and pre-select after the Modal's own focus effect has run, so the
  // field is ready to type over (matching the native prompt it replaces).
  useEffect(() => {
    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit(value);
  }

  return (
    <Modal title={title} onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        <label>
          <span>{label}</span>
          <input
            ref={inputRef}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={placeholder}
            maxLength={80}
          />
          {description && <small>{description}</small>}
        </label>
        <footer className="modal-actions">
          <button className="secondary-button" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary-button" type="submit">
            {submitLabel}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
