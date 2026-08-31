import { useEffect, useState, type ReactNode } from "react";
import { KeyRound, RefreshCw, Route, ShieldCheck, Timer } from "lucide-react";
import { ErrorState, LoadingState } from "../components/PanelState";
import { api, errorMessage } from "../lib/api";
import type { EffectiveSshConfiguration, EffectiveSshField, SavedConnection } from "../types";

export function SshConfigPane({ connection }: { connection: SavedConnection }) {
  const [configuration, setConfiguration] = useState<EffectiveSshConfiguration | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setConfiguration(await api.effectiveSshConfiguration(connection.id));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setConfiguration(null);
    void load();
  }, [connection.id]);

  if (loading && !configuration) return <LoadingState label="Resolving OpenSSH configuration…" />;
  if (error && !configuration) {
    return (
      <ErrorState message={error} action={<button onClick={() => void load()}>Retry</button>} />
    );
  }
  if (!configuration) return null;

  return (
    <section className="feature-page ssh-config-page">
      <header className="page-heading">
        <div>
          <h2>SSH Effective Configuration</h2>
          <p>Local values resolved by the installed OpenSSH client for {connection.displayName}.</p>
        </div>
        <button
          className="toolbar-button"
          type="button"
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCw size={14} /> {loading ? "Resolving…" : "Refresh"}
        </button>
      </header>

      <div className="ssh-config-run-meta" aria-label="Inspection status">
        <span>
          OpenSSH <strong>{configuration.sshVersion ?? "Version unavailable"}</strong>
        </span>
        <span>
          Exit status <strong>{configuration.exitStatus ?? "Unavailable"}</strong>
        </span>
        <span>
          Resolved <strong>{new Date(configuration.collectedAt).toLocaleString()}</strong>
        </span>
      </div>
      {configuration.diagnostic && (
        <p className="inline-error" role="alert">
          {configuration.diagnostic}
        </p>
      )}

      <div className="ssh-config-sections">
        <ConfigSection icon={<Route size={16} />} title="Connection">
          <ConfigField label="HostName" field={configuration.hostname} />
          <ConfigField label="User" field={configuration.user} />
          <ConfigField label="Port" field={configuration.port} />
          <ConfigField label="Address family" field={configuration.addressFamily} />
          <ConfigField label="Canonicalize hostname" field={configuration.canonicalizeHostname} />
        </ConfigSection>

        <ConfigSection icon={<KeyRound size={16} />} title="Authentication">
          <ConfigField label="Identities only" field={configuration.identitiesOnly} />
          {configuration.identityFiles.length ? (
            configuration.identityFiles.map((field, index) => (
              <ConfigField
                key={`${field.value}:${index}`}
                label={`IdentityFile ${index + 1}`}
                field={field}
              />
            ))
          ) : (
            <ConfigField label="IdentityFile" field={null} />
          )}
        </ConfigSection>

        <ConfigSection icon={<ShieldCheck size={16} />} title="Proxy route">
          <ConfigField label="ProxyJump" field={configuration.proxyJump} />
          <div className="ssh-config-field">
            <span>ProxyCommand</span>
            <div>
              <code>
                {configuration.proxyCommandConfigured
                  ? "Configured — command text redacted"
                  : "Not configured"}
              </code>
              <small>OpenSSH resolved</small>
            </div>
          </div>
        </ConfigSection>

        <ConfigSection icon={<Timer size={16} />} title="Connection reliability">
          <ConfigField label="Server alive interval" field={configuration.serverAliveInterval} />
          <ConfigField label="Server alive count max" field={configuration.serverAliveCountMax} />
          <ConfigField label="TCP keepalive" field={configuration.tcpKeepAlive} />
          <ConfigField label="Connect timeout" field={configuration.connectTimeout} />
        </ConfigSection>
      </div>

      <section className="ssh-config-limitations" aria-labelledby="ssh-config-limitations-title">
        <h3 id="ssh-config-limitations-title">Interpretation limits</h3>
        <ul>
          {configuration.parseLimitations.map((limitation) => (
            <li key={limitation}>{limitation}</li>
          ))}
        </ul>
        <p>
          This view runs local configuration inspection only. It does not connect to the host, open
          identity files, edit SSH configuration, or persist these results.
        </p>
      </section>
    </section>
  );
}

function ConfigSection({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="ssh-config-section">
      <header>
        {icon}
        <h3>{title}</h3>
      </header>
      <div>{children}</div>
    </section>
  );
}

function ConfigField({ label, field }: { label: string; field: EffectiveSshField | null }) {
  return (
    <div className="ssh-config-field">
      <span>{label}</span>
      <div>
        <code className={field ? undefined : "unavailable"}>{field?.value ?? "Not reported"}</code>
        {field && (
          <small>
            {field.origin === "savedConnectionOverride"
              ? "Saved Connection override"
              : "OpenSSH resolved"}
          </small>
        )}
      </div>
    </div>
  );
}
