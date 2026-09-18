# Agent-executed runner integration guide

This guide is the complete contract for building a container image that the
Deploy Commander agent executes for one manager run. It does not describe the
repository's `commanders/runner` one-shot Commander bootstrap utility.

## Purpose and lifecycle

An agent-executed runner is a one-shot container. The agent captures stdout
and stderr, reports Running before execution, reports Done or Failed from the
container outcome, and ACKs only after Commander accepts the terminal status.
Exit `0` means success; every non-zero exit (including interruption) means
failure. A crash before ACK can redeliver the run, so database writes, service
operations, migrations, and redirects must be idempotent. The token may stop
working before JWT expiry because the listener requires the run to remain in
its active-run registry.

## Injected runtime contract

| Facility               | Contract                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `AGENT_ENDPOINT`       | Runner HTTP origin in `tcp://host:port`, `http://`, `https://`, or `unix:///path.sock` form.                                |
| `TOKEN`                | Run bearer token; keep in memory, never log, and expect access to end when the run becomes inactive even before JWT expiry. |
| `/run/config.json`     | Read-only-at-start configuration containing trusted manager/run IDs, runner, platform, platform data, action, and metadata. |
| `/run/data`            | Persistent manager-named Docker volume for filesystem state across runs.                                                    |
| `/var/run/docker.sock` | Docker control socket; the runner is privileged enough to control the host daemon and must be treated accordingly.          |
| Primary network        | Manager-UUID Docker network used for run and durable service connectivity.                                                  |

The agent also attaches configured extra networks. The manager UUID is the
primary network name; durable services must attach to it. Do not expose the
socket, agent, or database to an untrusted network.

`/run/config.json` has this literal shape:

```json
{
  "manager": "<manager-uuid>",
  "run": "<run-uuid>",
  "runner": "registry.example/runner:1.0.0",
  "platform": "docker",
  "platform_data": null,
  "action": "deploy",
  "metadata": {}
}
```

`platform` and `platform_data` may be absent or null. `metadata` is always
present in the configuration model, is flexible BSON/JSON, and may itself be
null. Validate action and runner-owned metadata before side effects; metadata
is not authorization. Read the config before making calls and do not rewrite
it.

## Minimal image and HTTP client

Pin image and package versions according to your production release policy:

```dockerfile
FROM alpine:3.22
RUN apk add --no-cache curl jq docker-cli
COPY runner.sh /usr/local/bin/runner
RUN chmod 0755 /usr/local/bin/runner
ENTRYPOINT ["/usr/local/bin/runner"]
```

This POSIX-shell client implements all supported transports and bounded calls:

```sh
#!/bin/sh
set -eu
die() { printf '%s\n' "$*" >&2; exit 1; }
[ -n "${AGENT_ENDPOINT:-}" ] || die "AGENT_ENDPOINT is required"
[ -n "${TOKEN:-}" ] || die "TOKEN is required"
agent_request() {
  method=$1 path=$2 body=${3-}
  common="--connect-timeout 10 --max-time 300 --fail-with-body --silent --show-error"
  case "$AGENT_ENDPOINT" in
    tcp://*) url="http://${AGENT_ENDPOINT#tcp://}$path"; set -- curl $common -H "Authorization: Bearer $TOKEN" -H 'Accept: application/json' -X "$method" ;;
    http://*|https://*) url="${AGENT_ENDPOINT%/}$path"; set -- curl $common -H "Authorization: Bearer $TOKEN" -H 'Accept: application/json' -X "$method" ;;
    unix://*) socket=${AGENT_ENDPOINT#unix://}; url="http://agent$path"; set -- curl $common --unix-socket "$socket" -H "Authorization: Bearer $TOKEN" -H 'Accept: application/json' -X "$method" ;;
    *) die "AGENT_ENDPOINT must use tcp://, http://, https://, or unix://" ;;
  esac
  response=$(mktemp)
  if [ -n "$body" ]; then run_child "$@" -H 'Content-Type: application/json' --data "$body" "$url" >"$response" || return $?; else run_child "$@" "$url" >"$response" || return $?; fi
  REQUEST_RESPONSE=$response
}
```

Forward cancellation to child processes and make cleanup idempotent:

```sh
child=; cleanup() { [ -z "${child:-}" ] || { kill "$child" 2>/dev/null || true; wait "$child" 2>/dev/null || true; }; }
run_child() { "$@" & child=$!; rc=0; wait "$child" || rc=$?; child=; return "$rc"; }
trap 'cleanup; exit 143' TERM INT
```

Never enable curl tracing or shell `set -x`. Keep the token out of logs,
diagnostics, and crash reports. Redact non-2xx response bodies before logging.

## Complete entrypoint flow

The service-specific Docker commands are runner-owned, but this outline gives
the complete required ordering and outcome checks:

```sh
config=/run/config.json
[ -r "$config" ] || die "missing /run/config.json"
manager=$(jq -er '.manager | strings | select(length > 0)' "$config") || die "invalid manager"
run=$(jq -er '.run | strings | select(length > 0)' "$config") || die "invalid run"
runner=$(jq -er '.runner | strings | select(length > 0)' "$config") || die "invalid runner"
action=$(jq -er '.action | strings | select(. == "deploy" or . == "update" or . == "teardown")' "$config") || die "unsupported action"
jq -e 'has("metadata")' "$config" >/dev/null || die "metadata is required"
db_query() {
  agent_request POST /v1/database/query "$1" || die "database request failed"
  jq -e '.results | length > 0 and all(.status == "OK")' "$REQUEST_RESPONSE" >/dev/null || die "database statement failed"
}
deploy() {
  db_query '{"query":"BEGIN TRANSACTION; DEFINE TABLE IF NOT EXISTS deployment SCHEMALESS; DEFINE INDEX IF NOT EXISTS deployment_name ON TABLE deployment COLUMNS name UNIQUE; UPSERT deployment:current MERGE $state RETURN AFTER; COMMIT;","bindings":{"state":{"name":"current","version":1,"ready":false}}}'
  deploy_or_reconcile_service "$manager" "$run"
  wait_for_service_health
  agent_request PATCH /v1/manager/redirect '{"redirect":"http://service:8080"}' >/dev/null
  agent_request POST /v1/events '{"event":"phase","message":"deploy complete"}' >/dev/null
}
update() { db_query '{"query":"UPSERT deployment:current MERGE $state RETURN AFTER","bindings":{"state":{"version":2,"ready":false}}}'; update_or_reconcile_service "$manager" "$run"; wait_for_service_health; agent_request PATCH /v1/manager/redirect '{"redirect":"http://service:8080"}' >/dev/null; }
teardown() { agent_request PATCH /v1/manager/redirect '{"redirect":null}' >/dev/null; remove_durable_service "$manager"; }
agent_request POST /v1/events '{"event":"phase","message":"starting"}' >/dev/null
case "$action" in deploy) deploy ;; update) update ;; teardown) teardown ;; esac
```

The four service hooks must return nonzero on failure. Attach durable services
to the manager network and wait for health before redirect. For teardown clear
redirect first, then remove service/resources. Emit phases with stdout/stderr
(captured automatically) or `/v1/events`. `/v1/status` is optional progress;
the agent owns Running and terminal lifecycle statuses.

## Runner API reference

Every path is under `/v1` and uses `Authorization: Bearer <run-token>` and
`Accept: application/json`. Current success codes are `202` for events, status,
and redirect; `201` for resource/connection creation; `200` for lists,
details, and database queries; and `204` for deletes. Missing active runs are
`404` plain text `Run not found`; legacy route failures may be plain text.
Authentication is `401`; other routes can return route-specific `4xx`/`500`.

### Events, status, redirect

```http
POST /v1/events
Content-Type: application/json

{"event":"phase","message":"deploying"}
```

```http
POST /v1/status
Content-Type: application/json

{"status":1,"message":"working"}
```

Status values are 0 queued, 1 running, 2 done, 3 failed. The agent already
owns Running and terminal statuses. Redirect is:

```http
PATCH /v1/manager/redirect
Content-Type: application/json

{"redirect":"http://service:8080"}
```

Clear with `{"redirect":null}`.

### Resources

```http
GET /v1/resources?resource_type=platform&limit=20&offset=0&label=environment%3Dproduction&label=tier%3Dapi&label_match=all
```

`label` is repeatable and each filter is an exact `key=value` match. The
example requires both labels; use `label_match=any` to match either one.
The response remains a UUID array even when filters are present:
`["<resource-uuid>"]`. List responses never expand into resource objects or
include labels.

Create accepts an optional `labels` string map in addition to the exact Rust
`CreateResource` fields:

```http
POST /v1/resources
Content-Type: application/json

{"resource_type":"platform","name":"production","platform_connection":{"network":"manager"},"public_connection":{"address":"service","port":8080},"metadata":{"purpose":"deployment"},"labels":{"environment":"production","tier":"api"}}
```

Response: `{"id":"<resource-uuid>"}`. Resolve uses the exact `Resource`
fields:

```http
GET /v1/resources/<resource-uuid>?label_key=environment
```

```json
{
  "id": "<resource-uuid>",
  "resource_type": "platform",
  "name": "production",
  "connection": { "type": "Platform", "data": { "network": "manager" } },
  "metadata": { "purpose": "deployment" },
  "labels": { "environment": "production" }
}
```

`connection` may be null; its tagged forms are `Network` (data has
`address` and nullable `port`) and `Platform` (arbitrary data). Detail labels
are opt-in: use `?include_labels=true` for all labels, or one or more
`label_key` values for a projection, for example
`?label_key=environment&label_key=tier`. `label_key` implies label inclusion.
Filters apply to lists; they do not imply label inclusion in a detail response.

Set or replace one resource label with the active run's manager identity:

```http
PUT /v1/resources/<resource-uuid>/labels/environment
Content-Type: application/json

{"value":"production"}
```

The response is `{"key":"environment","value":"production"}`. Remove a
label with `DELETE /v1/resources/<resource-uuid>/labels/environment`; it is
idempotent and returns `204`. Resource-label mutation is allowed only when the
active run's manager owns the resource. Delete the resource itself by ID or
name with `DELETE /v1/resources/<resource-uuid>` or
`DELETE /v1/resources/name/production`; both return `204`.

### Connections

```http
GET /v1/connections?manager=<manager-uuid>&resource=<resource-uuid>&limit=20&offset=0&label=environment%3Dproduction&label=region%3Dwest&label_match=any
```

`label` is repeatable and exact; this example matches either label because it
uses `label_match=any`. The response remains a UUID array:
`["<connection-uuid>"]`, including when label filters are used. Create uses
the exact Rust `CreateConnection` fields (the non-label fields are required)
and accepts optional initial labels. Initial labels are stored separately and
never enter connection `metadata`:

```http
POST /v1/connections
Content-Type: application/json

{"id":"<connection-uuid>","resource":"<resource-uuid>","manager":"<manager-uuid>","metadata":{"purpose":"runtime"},"labels":{"environment":"production","region":"west"}}
```

Response: `{"id":"<connection-uuid>"}`. Resolve with label selection using
`GET /v1/connections/<resource-uuid>/<connection-uuid>?include_labels=true`,
or project keys with `?label_key=environment&label_key=region`. Resolve returns
exact `Connection` fields, e.g.
`{"id":"<connection-uuid>","resource":{"type":"Platform","data":{"network":"manager"}},"metadata":{"purpose":"runtime"},"labels":{"environment":"production","region":"west"}}`.

Set or replace one connection label:

```http
PUT /v1/connections/<connection-uuid>/labels/environment
Content-Type: application/json

{"value":"production"}
```

Remove it with `DELETE /v1/connections/<connection-uuid>/labels/environment`;
DELETE is idempotent and returns `204`. Connection-label mutation requires the
active run's manager to own the connected resource. Owning only the connection
is insufficient. Delete the connection itself through
`DELETE /v1/connections/<resource-uuid>/<connection-uuid>`; it returns `204`.

### Label validation and compatibility

Keys are trimmed and non-empty. Values are exact and may be empty. PUT creates
or replaces one key. DELETE is idempotent and returns `204`. Filters split on
the first `=`; `all` is the default and `any` is optional. `label_key` implies
inclusion. Filters do not imply inclusion. No label options means the pre-label
request and response contract. Runners cannot mutate manager or run labels.

Current resource and connection handlers do not consistently enforce the
active manager on every caller-supplied selector. Treat IDs as untrusted,
avoid cross-manager selectors, and never use these routes to recover or print
password-bearing connection metadata.

## Manager database query

`POST /v1/database/query` authenticates the token, resolves its active run,
derives the manager from that run, and executes the same policy-approved
manager database operation as the manager route. The request cannot select a
manager, namespace, database, credential, storage path, or agent.

```json
{ "query": "RETURN $value", "bindings": { "value": "example" } }
```

`query` is required and nonblank; `bindings` defaults to `{}`. Unknown fields,
trailing JSON, and non-JSON content type are rejected. Binding names contain
only ASCII letters, digits, and underscores, start with a letter/underscore,
and are at most 128 bytes. At most 1,024 bindings; collection size is 100,000
items; depth is 64; strings and object keys are at most 16 MiB; and the body
is at most 16 MiB. Values support null, booleans, numbers, strings, arrays,
and objects. Always bind values rather than interpolate untrusted text.

Successful, mixed, and all-error statement sets are HTTP 200:

```json
{
  "results": [
    {
      "statement": 0,
      "status": "OK",
      "time": "152.5µs",
      "result": [{ "id": "current", "ready": false }]
    }
  ]
}
```

```json
{
  "results": [
    { "statement": 0, "status": "OK", "time": "1ms", "result": 1 },
    {
      "statement": 1,
      "status": "ERR",
      "time": "2ms",
      "result": "database-provided statement error value"
    }
  ]
}
```

```json
{
  "results": [
    {
      "statement": 0,
      "status": "ERR",
      "time": "2ms",
      "result": "database-provided statement error value"
    }
  ]
}
```

`statement` is zero-based server order; `status` is exactly `OK` or `ERR`;
`time` is non-empty; `result` is always arbitrary JSON. HTTP 200 means the
exchange completed, not that all statements succeeded.

Whole-query errors have exactly `code` and `message`, for example
`{"code":"surrealql_policy_rejected","message":"query policy rejected the request"}`.
Mapping is: 400 malformed/trailing JSON or parse failure; 401 missing,
invalid, or expired token; 403 policy rejection; 404 inactive run (`Run not
found`, plain text); 413 body over 16 MiB; 415 non-JSON content type; 422
invalid request/bindings or whole-query execution failure without valid
statement outcomes; 500 storage or response-conversion failure. Errors are
sanitized and contain no query, bindings, credentials, paths, or backend text.

The policy allows approved reads, writes, transactions, and schema changes,
but rejects protected namespace/database context and authorization changes,
scripting, outbound network access, dynamic SurrealQL/GQL evaluation, and
capability escapes. The fixed namespace is `managers` and database is the
active manager UUID.

Use stable IDs and this idempotent migration pattern:

```json
{
  "query": "BEGIN TRANSACTION; DEFINE TABLE IF NOT EXISTS deployment SCHEMALESS; DEFINE INDEX IF NOT EXISTS deployment_name ON TABLE deployment COLUMNS name UNIQUE; UPSERT deployment:current MERGE $state RETURN AFTER; COMMIT;",
  "bindings": { "state": { "name": "current", "version": 1, "ready": false } }
}
```

Check every returned statement, including `COMMIT`. Prefer `UPSERT`,
`IF NOT EXISTS`, unique indexes, and deterministic IDs. If transport fails
after a write may have been transmitted, do not blindly retry: read the stable
record ID/version first and retry only when reconciliation proves it absent or
incomplete. Use the manager database for shared structured state, schemas,
deployment inventory, migrations, and later-run queries. Use `/run/data` for
manager-local files, generated assets, caches, and filesystem artifacts.

## Docker, testing, and release checklists

The socket grants host-daemon control; use least privilege and no unrelated
host mounts. Attach services to the manager network, health-check them, then
set redirect. Clear redirect before teardown. Side effects must tolerate
redelivery and SIGTERM. For local tests use fake credentials only:

```sh
tmp=$(mktemp -d); mkdir -p "$tmp/run-data" "$tmp/socket"
docker build -t runner:test .
MOCK_SOCKET=$tmp/socket/agent.sock python3 - <<'PY' & mock_pid=$!
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import UnixStreamServer
import os
from threading import Thread
class H(BaseHTTPRequestHandler):
  def _ok(self): self.send_response(200); self.end_headers(); self.wfile.write(b'{"results":[{"statement":0,"status":"OK","time":"0ms","result":1}]}')
  do_POST = _ok
  do_PATCH = _ok
  do_GET = _ok
  do_DELETE = _ok
  def log_message(self, *_): pass
Thread(target=HTTPServer(('127.0.0.1',18080), H).serve_forever, daemon=True).start()
UnixStreamServer(os.environ['MOCK_SOCKET'], H).serve_forever()
PY
cat >"$tmp/config.json" <<'JSON'
{"manager":"00000000-0000-0000-0000-000000000001","run":"00000000-0000-0000-0000-000000000002","runner":"example/runner:test","platform":"docker","platform_data":null,"action":"deploy","metadata":{}}
JSON
docker run --rm --network host \
  -v "$tmp/config.json:/run/config.json:ro" -v "$tmp/run-data:/run/data" \
  -e AGENT_ENDPOINT=tcp://127.0.0.1:18080 -e TOKEN=fake-test-token runner:test
docker run --rm --network none \
  -v "$tmp/config.json:/run/config.json:ro" -v "$tmp/run-data:/run/data" \
  -v "$tmp/socket:/run/agent:ro" -e AGENT_ENDPOINT=unix:///run/agent/agent.sock \
  -e TOKEN=fake-test-token runner:test
kill "$mock_pid" 2>/dev/null || true
```

Use a mock HTTP server that does not record Authorization headers. Test
malformed/absent config, invalid token, inactive run, mixed/all-error results,
ambiguous write failure, SIGTERM, nonzero exit, timeout, 413/415, and token
redaction. Before release verify bounded calls, result-status inspection,
manager isolation, network attachment, health-before-redirect, teardown order,
idempotency, multi-architecture images, and immutable tags/digests.
For this harness define `deploy_or_reconcile_service`,
`update_or_reconcile_service`, `wait_for_service_health`, and
`remove_durable_service` as no-op shell functions before invoking the sample;
production runners replace them with real, idempotent operations.
