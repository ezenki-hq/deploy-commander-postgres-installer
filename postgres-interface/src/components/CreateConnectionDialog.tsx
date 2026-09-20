import { useState } from 'react';
import type { AccessRequest } from '../domain/requests';
import type { CreateApprovalContext, CreateApprovalDecision } from '../workflows/createConnection';
import { ApprovalDialog } from './ApprovalDialog';

export function CreateConnectionDialog({
  context,
  onDecision,
}: {
  context: CreateApprovalContext;
  onDecision: (decision: CreateApprovalDecision) => void;
}) {
  const [scope, setScope] = useState<'database' | 'full'>(
    context.requestedAccess?.scope ?? 'database',
  );
  const [database, setDatabase] = useState(
    context.requestedAccess?.scope === 'database'
      ? context.requestedAccess.database
      : (context.databaseNames[0] ?? ''),
  );
  const [operation, setOperation] = useState<'create' | 'existing'>(
    context.requestedAccess?.scope === 'database' ? context.requestedAccess.operation : 'create',
  );
  const [superuser, setSuperuser] = useState(
    context.requestedAccess?.scope === 'full' ? context.requestedAccess.superuser : false,
  );
  const fixed = context.requestedAccess;
  const access: AccessRequest =
    scope === 'database' ? { scope, operation, database } : { scope, superuser };
  const canApprove = fixed !== null || scope === 'full' || database.trim() !== '';
  return (
    <ApprovalDialog
      title="Approve PostgreSQL connection"
      onReject={() => onDecision({ allowed: false })}
      onApprove={() => onDecision({ allowed: true, access })}
      approveDisabled={!canApprove}
    >
      <p className="leading-6">
        Review the PostgreSQL access requested by <strong>{context.callingManagerId}</strong>.
      </p>
      {fixed ? (
        <dl className="rounded-xl bg-slate-50 px-4 py-3">
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Access</dt>
          <dd className="mt-1 font-medium text-slate-900">
            {fixed.scope === 'database'
              ? `${fixed.operation} database ${fixed.database}`
              : `full${fixed.superuser ? ' superuser' : ' constrained'} access`}
          </dd>
        </dl>
      ) : (
        <>
          <label className="grid gap-2 font-medium text-slate-800">
            <span>Scope</span>
            <select
              className="rounded-lg border border-slate-300 bg-white px-3 py-2"
              value={scope}
              onChange={(event) => setScope(event.target.value as 'database' | 'full')}
            >
              <option value="database">Database</option>
              <option value="full">Full access</option>
            </select>
          </label>
          {scope === 'database' ? (
            <>
              <label className="grid gap-2 font-medium text-slate-800">
                <span>Database</span>
                <input
                  className="rounded-lg border border-slate-300 px-3 py-2"
                  value={database}
                  list="postgres-databases"
                  onChange={(event) => setDatabase(event.target.value)}
                />
              </label>
              <datalist id="postgres-databases">
                {context.databaseNames.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
              <label className="grid gap-2 font-medium text-slate-800">
                <span>Operation</span>
                <select
                  className="rounded-lg border border-slate-300 bg-white px-3 py-2"
                  value={operation}
                  onChange={(event) => setOperation(event.target.value as 'create' | 'existing')}
                >
                  <option value="create">Create manager-owned database</option>
                  <option value="existing">Use existing database</option>
                </select>
              </label>
            </>
          ) : (
            <label className="flex items-center gap-2 font-medium text-slate-800">
              <input
                type="checkbox"
                checked={superuser}
                onChange={(event) => setSuperuser(event.target.checked)}
              />
              <span>Superuser access</span>
            </label>
          )}
        </>
      )}
      {access.scope === 'full' && access.superuser && (
        <p
          role="alert"
          className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900"
        >
          Full superuser access grants unrestricted access to every PostgreSQL database.
        </p>
      )}
      <p className="text-xs leading-5 text-slate-500">
        Labels:{' '}
        {Object.keys(context.callerLabels).length
          ? Object.entries(context.callerLabels)
              .map(([key, value]) => `${key}=${value}`)
              .join(', ')
          : 'none'}
      </p>
    </ApprovalDialog>
  );
}
