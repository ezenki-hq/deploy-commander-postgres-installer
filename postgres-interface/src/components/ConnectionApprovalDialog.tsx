import { useState } from 'react';
import ActionApprovalDialog from './ActionApprovalDialog';
import ActionButton from './ActionButton';
import type { ApprovalContext } from '../lib/createPostgresConnection';
import {
  generateDatabaseName,
  type AccessRequest,
  type ParsedConnectionRequest,
} from '../lib/postgresConnectionRequest';
import type { ActionGateState } from '../lib/actionGate';

export interface ConnectionApprovalDialogProps {
  gate: ActionGateState<ApprovalContext>;
  request: ParsedConnectionRequest;
  onApprove: (access: AccessRequest) => void;
  onReject: () => void;
  onRetry: () => void;
  generateName?: () => string;
}

const validDatabaseName = (name: string): boolean => {
  if (name.length === 0 || name.includes('\0')) return false;
  if (name.toLowerCase() === 'template0' || name.toLowerCase() === 'template1') return false;
  return new TextEncoder().encode(name).length <= 63;
};

function labels(context: ApprovalContext): React.ReactNode {
  const entries = Object.entries(context.callerLabels);
  if (entries.length === 0) return <span className="text-slate-500">None</span>;
  return entries.map(([key, value]) => (
    <span
      key={key}
      className="mr-2 inline-block rounded bg-slate-100 px-2 py-1 font-mono text-xs"
      data-testid="caller-label"
    >
      {key}={value}
    </span>
  ));
}

function RequestSummary({ access }: { access: AccessRequest }) {
  return (
    <dl className="mt-5 grid gap-3 rounded-xl bg-slate-50 p-4 text-sm sm:grid-cols-2">
      <div>
        <dt className="font-semibold text-slate-500">Access</dt>
        <dd className="mt-1 text-slate-800">
          {access.scope === 'database' ? 'Database' : 'Full PostgreSQL access'}
        </dd>
      </div>
      {access.scope === 'database' ? (
        <>
          <div>
            <dt className="font-semibold text-slate-500">Operation</dt>
            <dd className="mt-1 text-slate-800">
              {access.operation === 'create' ? 'Create new database' : 'Use existing database'}
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-500">Database</dt>
            <dd className="mt-1 break-all font-mono text-slate-800">{access.database}</dd>
          </div>
        </>
      ) : (
        <div>
          <dt className="font-semibold text-slate-500">Privilege level</dt>
          <dd className="mt-1 text-slate-800">
            {access.superuser ? 'Dedicated superuser' : 'Constrained full access'}
          </dd>
        </div>
      )}
    </dl>
  );
}

export function ConnectionApprovalDialog({
  gate,
  request,
  onApprove,
  onReject,
  onRetry,
  generateName = generateDatabaseName,
}: ConnectionApprovalDialogProps) {
  const context = gate.kind === 'ready' || gate.kind === 'executing' ? gate.context : null;
  const busy = gate.kind === 'executing';
  const requested = context?.requestedAccess ?? request.access;
  const [scope, setScope] = useState<'database' | 'full'>('database');
  const [operation, setOperation] = useState<'create' | 'existing'>('create');
  const [database, setDatabase] = useState('');
  const [superuser, setSuperuser] = useState(false);
  const access: AccessRequest | null =
    requested ??
    (scope === 'full' ? { scope: 'full', superuser } : { scope: 'database', operation, database });
  const valid = access !== null && (access.scope === 'full' || validDatabaseName(access.database));

  const approve = () => {
    if (gate.kind === 'ready' && valid && access) onApprove(access);
  };

  const review = context ? (
    <>
      <div className="mt-5 text-sm text-slate-700">
        <span className="font-semibold">Caller labels</span>
        <div className="mt-2" data-testid="caller-labels">
          {labels(context)}
        </div>
      </div>
      {requested ? (
        <>
          <RequestSummary access={requested} />
          {requested.scope === 'full' && requested.superuser && (
            <p
              role="alert"
              className="mt-4 rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm font-semibold text-rose-900"
            >
              Superuser access can read and change every database. Approve only if the calling
              manager is fully trusted.
            </p>
          )}
        </>
      ) : (
        <div className="mt-5 space-y-5">
          <fieldset>
            <legend className="text-sm font-semibold text-slate-800">Access scope</legend>
            <div className="mt-2 flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="access-scope"
                  value="database"
                  checked={scope === 'database'}
                  disabled={busy}
                  onChange={() => setScope('database')}
                />
                Database
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="access-scope"
                  value="full"
                  checked={scope === 'full'}
                  disabled={busy}
                  onChange={() => setScope('full')}
                />
                Full access
              </label>
            </div>
          </fieldset>
          {scope === 'database' ? (
            <div className="space-y-4">
              <fieldset>
                <legend className="text-sm font-semibold text-slate-800">Database operation</legend>
                <div className="mt-2 flex flex-wrap gap-4 text-sm">
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="database-operation"
                      value="create"
                      checked={operation === 'create'}
                      disabled={busy}
                      onChange={() => {
                        setOperation('create');
                        setDatabase('');
                      }}
                    />
                    Create a new database
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="database-operation"
                      value="existing"
                      checked={operation === 'existing'}
                      disabled={busy}
                      onChange={() => {
                        setOperation('existing');
                        setDatabase('');
                      }}
                    />
                    Use an existing database
                  </label>
                </div>
              </fieldset>
              {operation === 'existing' && context.catalogDatabases.length > 0 && (
                <label className="block text-sm text-slate-700">
                  <span className="font-semibold">Available database</span>
                  <select
                    aria-label="Available database"
                    value={context.catalogDatabases.includes(database) ? database : ''}
                    disabled={busy}
                    onChange={(event) => setDatabase(event.target.value)}
                    className="mt-2 block min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 py-2"
                  >
                    <option value="">Choose a catalog database</option>
                    {context.catalogDatabases.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="block text-sm text-slate-700">
                <span className="font-semibold">Database name</span>
                <input
                  aria-label="Database name"
                  value={database}
                  disabled={busy}
                  onChange={(event) => setDatabase(event.target.value)}
                  className="mt-2 block min-h-11 w-full rounded-xl border border-slate-300 px-3 py-2 font-mono"
                />
              </label>
              <ActionButton
                tone="secondary"
                disabled={busy}
                onClick={() => setDatabase(generateName())}
              >
                Generate database name
              </ActionButton>
              {!valid && database.length > 0 && (
                <p role="alert" className="text-sm text-rose-700">
                  Enter a valid PostgreSQL database name (up to 63 UTF-8 bytes).
                </p>
              )}
            </div>
          ) : (
            <fieldset>
              <legend className="text-sm font-semibold text-slate-800">Privilege level</legend>
              <div className="mt-2 space-y-2 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="full-privilege"
                    checked={!superuser}
                    disabled={busy}
                    onChange={() => setSuperuser(false)}
                  />
                  Constrained full access
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="full-privilege"
                    checked={superuser}
                    disabled={busy}
                    onChange={() => setSuperuser(true)}
                  />
                  Dedicated superuser
                </label>
              </div>
              {superuser && (
                <p
                  role="alert"
                  className="mt-3 rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm font-semibold text-rose-900"
                >
                  Superuser access can read and change every database. Approve only if the calling
                  manager is fully trusted.
                </p>
              )}
            </fieldset>
          )}
        </div>
      )}
    </>
  ) : null;

  const phase =
    gate.kind === 'preparing' ||
    gate.kind === 'blocked' ||
    gate.kind === 'ready' ||
    gate.kind === 'executing'
      ? gate.kind
      : 'preparing';
  const status =
    gate.kind === 'preparing'
      ? gate.callerId
        ? 'Checking PostgreSQL installation and available databases before approval…'
        : 'Identifying the calling manager…'
      : gate.kind === 'executing'
        ? 'Creating PostgreSQL connection…'
        : undefined;

  return (
    <ActionApprovalDialog
      title="Approve PostgreSQL access?"
      callerId={gate.kind === 'closed' ? null : gate.callerId}
      phase={phase}
      status={status}
      error={gate.kind === 'blocked' ? gate.failure.message : undefined}
      onReject={onReject}
      retryAction={
        gate.kind === 'blocked' && gate.failure.retryable ? (
          <ActionButton tone="secondary" onClick={onRetry}>
            Retry
          </ActionButton>
        ) : undefined
      }
      primaryAction={
        gate.kind === 'ready' ? (
          <ActionButton tone="primary" disabled={!valid} onClick={approve}>
            Approve connection
          </ActionButton>
        ) : gate.kind === 'executing' ? (
          <ActionButton tone="primary" disabled>
            Creating connection…
          </ActionButton>
        ) : undefined
      }
    >
      {review}
    </ActionApprovalDialog>
  );
}

export default ConnectionApprovalDialog;
