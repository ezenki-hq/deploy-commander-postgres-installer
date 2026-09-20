# PostgreSQL Manager

React/TypeScript manager interface for Deploy Commander. Durable installation state comes from the
managed PostgreSQL resource; logical access and database ownership come from current connections
and their reserved labels. Run events provide transient progress only.

The interface uses Tailwind CSS v4 through the Vite plugin. It is scaffolded for the package CLI
(`npx deploy-commander`) and keeps publishing separate from building.

## Behavior

- Clicking Install PostgreSQL authorizes the installation directly; no second confirmation appears.
- After installation completes, the dashboard refreshes the resource and connection projection and
  shows Teardown PostgreSQL without a page reload.
- Teardown uses an accessible in-app destructive confirmation. Cancel, Escape, and focus restoration
  do not start a run.
- Every create-connection and delete-connection child request shows an approval dialog before any
  mutation or tracked run. Rejection closes with status `499`.
- Progress is driven by run-start/run-update events and the exact terminal run read. Failures show a
  sanitized alert and never expose credentials, SQL, runner logs, or raw metadata.

The public child-interface request/result contract is documented in
`docs/integrations/POSTGRES_MANAGER_INTERFACE_GUIDE.md`.

## Commands

- Install: npm install
- Dev: npm run dev
- Build: npm run build
- Format: npm run format
- Check formatting: npm run format:check
- Publish: npm run publish:manager
- Deploy: npm run deploy

`npm run publish:manager` expects the user-supplied Commander URL and credentials through the
supported environment or adjacent uncommitted `.env`. `deploy-commander.json` is intentionally
target-neutral; this project does not publish as part of local verification.

## Verification

```bash
npm test
npm run lint
npm run build
npm run format:check
npx deploy-commander --help
```
