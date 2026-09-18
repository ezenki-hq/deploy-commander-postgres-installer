import { useState } from 'react';
import ActionButton from './ActionButton';
import useDialogFocus from './useDialogFocus';
import type { ApprovalContext } from '../lib/createPostgresConnection';
import { generateDatabaseName, type AccessRequest } from '../lib/postgresConnectionRequest';

export interface ConnectionApprovalDialogProps {
  context: ApprovalContext;
  busy: boolean;
  onApprove: (access: AccessRequest) => void;
  onReject: () => void;
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
    <span key={key} className="mr-2 inline-block rounded bg-slate-100 px-2 py-1 font-mono text-xs" data-testid="caller-label">
      {key}={value}
    </span>
  ));
}

function RequestSummary({ access }: { access: AccessRequest }) {
  return (
    <dl className="mt-5 grid gap-3 rounded-xl bg-slate-50 p-4 text-sm sm:grid-cols-2">
      <div><dt className="font-semibold text-slate-500">Access</dt><dd className="mt-1 text-slate-800">{access.scope === 'database' ? 'Database' : 'Full PostgreSQL access'}</dd></div>
      {access.scope === 'database' ? <>
        <div><dt className="font-semibold text-slate-500">Operation</dt><dd className="mt-1 text-slate-800">{access.operation === 'create' ? 'Create new database' : 'Use existing database'}</dd></div>
        <div><dt className="font-semibold text-slate-500">Database</dt><dd className="mt-1 break-all font-mono text-slate-800">{access.database}</dd></div>
      </> : <div>
        <dt className="font-semibold text-slate-500">Privilege level</dt>
        <dd className="mt-1 text-slate-800">{access.superuser ? 'Dedicated superuser' : 'Constrained full access'}</dd>
      </div>}
    </dl>
  );
}

export function ConnectionApprovalDialog({
  context,
  busy,
  onApprove,
  onReject,
  generateName = generateDatabaseName,
}: ConnectionApprovalDialogProps) {
  const requested = context.requestedAccess;
  const [scope, setScope] = useState<'database' | 'full'>('database');
  const [operation, setOperation] = useState<'create' | 'existing'>('create');
  const [database, setDatabase] = useState('');
  const [superuser, setSuperuser] = useState(false);
  const dialogRef = useDialogFocus<HTMLDivElement>(!busy, onReject);
  const access: AccessRequest | null = requested ?? (scope === 'full'
    ? { scope: 'full', superuser }
    : { scope: 'database', operation, database });
  const valid = access !== null && (access.scope === 'full' || validDatabaseName(access.database));

  const approve = () => {
    if (!busy && valid && access) onApprove(access);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-950/60 p-4 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-busy={busy}
        tabIndex={-1}
        aria-labelledby="connection-approval-title"
        aria-describedby="connection-approval-description"
        className="max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-2xl border border-indigo-100 bg-white p-6 shadow-2xl outline-none sm:p-7"
      >
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-indigo-700">Connection approval</p>
        <h2 id="connection-approval-title" className="mt-2 text-2xl font-semibold tracking-tight">
          Approve PostgreSQL access?
        </h2>
        <p id="connection-approval-description" className="mt-3 text-sm leading-6 text-slate-600">
          The calling manager
          <span data-testid="calling-manager-id" className="mt-2 block break-all rounded-lg bg-slate-100 px-3 py-2 font-mono text-xs text-slate-800">
            {context.callingManagerId}
          </span>
          {context.installsPostgres
            ? 'This request will install PostgreSQL before creating the approved connection.'
            : 'is requesting a connection to this PostgreSQL installation.'}
        </p>

        <div className="mt-5 text-sm text-slate-700">
          <span className="font-semibold">Caller labels</span>
          <div className="mt-2" data-testid="caller-labels">{labels(context)}</div>
        </div>

        {requested ? <>
          <RequestSummary access={requested} />
          {requested.scope === 'full' && requested.superuser && <p role="alert" className="mt-4 rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm font-semibold text-rose-900">Superuser access can read and change every database. Approve only if the calling manager is fully trusted.</p>}
        </> : <div className="mt-5 space-y-5">
          <fieldset>
            <legend className="text-sm font-semibold text-slate-800">Access scope</legend>
            <div className="mt-2 flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2"><input type="radio" name="access-scope" value="database" checked={scope === 'database'} disabled={busy} onChange={() => setScope('database')} />Database</label>
              <label className="flex items-center gap-2"><input type="radio" name="access-scope" value="full" checked={scope === 'full'} disabled={busy} onChange={() => setScope('full')} />Full access</label>
            </div>
          </fieldset>

          {scope === 'database' ? <div className="space-y-4">
            <fieldset>
              <legend className="text-sm font-semibold text-slate-800">Database operation</legend>
              <div className="mt-2 flex flex-wrap gap-4 text-sm">
                <label className="flex items-center gap-2"><input type="radio" name="database-operation" value="create" checked={operation === 'create'} disabled={busy} onChange={() => { setOperation('create'); setDatabase(''); }} />Create a new database</label>
                <label className="flex items-center gap-2"><input type="radio" name="database-operation" value="existing" checked={operation === 'existing'} disabled={busy} onChange={() => { setOperation('existing'); setDatabase(''); }} />Use an existing database</label>
              </div>
            </fieldset>
            {operation === 'existing' && context.catalogDatabases.length > 0 && <label className="block text-sm text-slate-700">
              <span className="font-semibold">Available database</span>
              <select aria-label="Available database" value={context.catalogDatabases.includes(database) ? database : ''} disabled={busy} onChange={(event) => setDatabase(event.target.value)} className="mt-2 block min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 py-2">
                <option value="">Choose a catalog database</option>
                {context.catalogDatabases.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>}
            <label className="block text-sm text-slate-700">
              <span className="font-semibold">Database name</span>
              <input aria-label="Database name" value={database} disabled={busy} onChange={(event) => setDatabase(event.target.value)} className="mt-2 block min-h-11 w-full rounded-xl border border-slate-300 px-3 py-2 font-mono" />
            </label>
            <ActionButton tone="secondary" disabled={busy} onClick={() => setDatabase(generateName())}>Generate database name</ActionButton>
            {!valid && database.length > 0 && <p role="alert" className="text-sm text-rose-700">Enter a valid PostgreSQL database name (up to 63 UTF-8 bytes).</p>}
          </div> : <fieldset>
            <legend className="text-sm font-semibold text-slate-800">Privilege level</legend>
            <div className="mt-2 space-y-2 text-sm">
              <label className="flex items-center gap-2"><input type="radio" name="full-privilege" checked={!superuser} disabled={busy} onChange={() => setSuperuser(false)} />Constrained full access</label>
              <label className="flex items-center gap-2"><input type="radio" name="full-privilege" checked={superuser} disabled={busy} onChange={() => setSuperuser(true)} />Dedicated superuser</label>
            </div>
            {superuser && <p role="alert" className="mt-3 rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm font-semibold text-rose-900">Superuser access can read and change every database. Approve only if the calling manager is fully trusted.</p>}
          </fieldset>}
        </div>}

        {busy && <p role="status" aria-live="polite" className="mt-4 text-sm font-medium text-indigo-700">Requesting access…</p>}
        <div className="mt-7 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <ActionButton tone="secondary" disabled={busy} onClick={onReject}>Reject</ActionButton>
          <ActionButton tone="primary" disabled={busy || !valid} onClick={approve}>Approve connection</ActionButton>
        </div>
      </div>
    </div>
  );
}

export default ConnectionApprovalDialog;
