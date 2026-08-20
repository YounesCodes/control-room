import { useState, type FormEvent } from "react";
import { Modal } from "./Modal";

interface CredentialDialogProps {
  connectionLabel: string;
  onClose: () => void;
  onSubmit: (password: string) => Promise<void>;
}

export function CredentialDialog({ connectionLabel, onClose, onSubmit }: CredentialDialogProps) {
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = password;
    setPassword("");
    setSubmitting(true);
    try {
      await onSubmit(value);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Sudo required" onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        <p className="modal-copy">
          Control Room needs sudo to repeat this read-only request on {connectionLabel}.
        </p>
        <label>
          <span>Password</span>
          <input
            autoFocus
            type="password"
            autoComplete="off"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
          <small>This password is sent once and will not be saved.</small>
        </label>
        <footer className="modal-actions">
          <button className="secondary-button" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary-button" type="submit" disabled={submitting || !password}>
            {submitting ? "Retrying…" : "Continue"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
