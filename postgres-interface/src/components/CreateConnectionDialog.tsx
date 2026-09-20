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
      <p>
        Review the PostgreSQL access requested by <strong>{context.callingManagerId}</strong>.
      </p>
      {fixed ? (
        <dl>
          <dt>Access</dt>
          <dd>
            {fixed.scope === 'database'
              ? `${fixed.operation} database ${fixed.database}`
              : `full${fixed.superuser ? ' superuser' : ' constrained'} access`}
          </dd>
        </dl>
      ) : (
        <>
          <label>
            Scope
            <select
              value={scope}
              onChange={(event) => setScope(event.target.value as 'database' | 'full')}
            >
              <option value="database">Database</option>
              <option value="full">Full access</option>
            </select>
          </label>
          {scope === 'database' ? (
            <>
              <label>
                Database
                <input
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
              <label>
                Operation
                <select
                  value={operation}
                  onChange={(event) => setOperation(event.target.value as 'create' | 'existing')}
                >
                  <option value="create">Create manager-owned database</option>
                  <option value="existing">Use existing database</option>
                </select>
              </label>
            </>
          ) : (
            <label>
              <input
                type="checkbox"
                checked={superuser}
                onChange={(event) => setSuperuser(event.target.checked)}
              />{' '}
              Superuser access
            </label>
          )}
        </>
      )}
      <p>
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
