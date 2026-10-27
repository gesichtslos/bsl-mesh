import { readFileSync } from 'node:fs';

const composePath = process.argv[2];
const caddyPath = process.argv[3];
if (composePath === undefined || caddyPath === undefined) {
  process.stderr.write('usage: check-production-config.mjs <compose-config.json> <caddy-adapt.json>\n');
  process.exit(1);
}

const compose = JSON.parse(readFileSync(composePath, 'utf8'));
const caddy = JSON.parse(readFileSync(caddyPath, 'utf8'));
const errors = [];

function environmentMap(service) {
  const environment = service?.environment ?? {};
  if (Array.isArray(environment)) {
    return Object.fromEntries(environment.map((entry) => {
      const separator = entry.indexOf('=');
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    }));
  }
  return environment;
}

function collectRoutes(node, routes) {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectRoutes(item, routes);
    }
    return;
  }
  if (node === null || typeof node !== 'object') {
    return;
  }
  if (Array.isArray(node.routes)) {
    routes.push(...node.routes);
  }
  for (const value of Object.values(node)) {
    collectRoutes(value, routes);
  }
}

function publishedPorts(service) {
  return service?.ports ?? [];
}

const db = compose.services?.db;
const app = compose.services?.app;
const migrate = compose.services?.migrate;
const proxy = compose.services?.caddy;
const appEnv = environmentMap(app);
const migrateEnv = environmentMap(migrate);
const dbEnv = environmentMap(db);
if (db === undefined || app === undefined || migrate === undefined || proxy === undefined) {
  errors.push('production compose is missing db, migrate, app, or caddy');
}
if (db !== undefined && publishedPorts(db).length !== 0) {
  errors.push('PostgreSQL publishes a host port');
}
if (app !== undefined && publishedPorts(app).length !== 0) {
  errors.push('Fastify publishes a host port');
}
if (migrate !== undefined && publishedPorts(migrate).length !== 0) {
  errors.push('the migration service publishes a host port');
}
const caddyPorts = publishedPorts(proxy ?? {}).map((port) => `${port.published}/${port.protocol ?? 'tcp'}`);
for (const expected of ['80/tcp', '443/tcp', '443/udp']) {
  if (!caddyPorts.includes(expected)) {
    errors.push(`Caddy is missing published port ${expected}`);
  }
}
const volume = compose.volumes?.pgdata;
if (volume?.external !== true || volume?.name !== 'bsl-mesh-production_pgdata') {
  errors.push('PostgreSQL volume must be the external production volume bsl-mesh-production_pgdata');
}
if (volume?.name === 'bsl-mesh-staging_pgdata') {
  errors.push('PostgreSQL volume must not be the staging volume');
}
if (appEnv.PUBLIC_HOSTNAME !== 'bslmesh.ru' || appEnv.TRUST_PROXY_HOPS !== '1') {
  errors.push('the application is not configured for bslmesh.ru behind one proxy hop');
}
if (appEnv.PGUSER !== 'bslmesh_app') {
  errors.push('the application is not using the limited database role');
}
const expectedHandoff = process.env.CHECK_HANDOFF_ENABLED ?? 'disabled';
if (expectedHandoff !== 'disabled' && expectedHandoff !== 'enabled') {
  errors.push('CHECK_HANDOFF_ENABLED must be disabled or enabled');
}
if (appEnv.HANDOFF_ENABLED !== expectedHandoff) {
  errors.push(`the application handoff flag is ${appEnv.HANDOFF_ENABLED ?? 'unset'}, expected ${expectedHandoff}`);
}
const appCommand = JSON.stringify(app?.entrypoint ?? app?.command ?? []);
if (!appCommand.includes('dist/server.js') || appCommand.includes('migrate.js')) {
  errors.push('the application process still runs migrations');
}
if (migrateEnv.PGUSER !== 'bslmesh_admin') {
  errors.push('schema changes are not started by the administrator role');
}
const migrateCommand = JSON.stringify(migrate?.entrypoint ?? []);
if (!migrateCommand.includes('production-migrate.sh')) {
  errors.push('schema changes do not use the separate migration entrypoint');
}

const http = caddy.apps?.http;
const servers = Object.values(http?.servers ?? {});
const hosts = JSON.stringify(servers);
if (!hosts.includes('bslmesh.ru')) {
  errors.push('production Caddy does not serve bslmesh.ru');
}
if (JSON.stringify(caddy).includes('"disable":true') && hosts.includes('"disable":true')) {
  errors.push('production Caddy disables automatic HTTPS');
}
const expectedPassword = process.env.CHECK_POSTGRES_PASSWORD;
if (expectedPassword !== undefined && dbEnv.POSTGRES_PASSWORD !== expectedPassword) {
  errors.push('Compose interpolated a password other than the disposable check value');
}
const composeSource = readFileSync('compose.production.yaml', 'utf8');
if (composeSource.includes('bsl-mesh-staging_pgdata')) {
  errors.push('production compose still references the staging database volume');
}
const source = readFileSync('Caddyfile.production', 'utf8');
if (/auto_https\s+off/.test(source) || /tls\s+internal/.test(source)) {
  errors.push('production Caddyfile disables public certificates');
}
const routes = [];
collectRoutes(caddy, routes);
const rootRedirect = routes.some((route) => {
  const paths = (route.match ?? []).flatMap((match) => match.path ?? []);
  return paths.length === 1 && paths[0] === '/' && (route.handle ?? []).some((handle) => (
    handle.handler === 'static_response'
    && handle.status_code === 302
    && handle.headers?.Location?.[0] === '/start'
  ));
});
const applicationProxy = routes.some((route) => (route.handle ?? []).some((handle) => (
  handle.handler === 'reverse_proxy'
  && (handle.upstreams ?? []).some((upstream) => upstream.dial === 'app:3000')
)));
if (!rootRedirect) {
  errors.push('the site root does not redirect to /start with status 302');
}
if (!applicationProxy) {
  errors.push('Caddy no longer proxies application routes to app:3000');
}

if (errors.length > 0) {
  for (const error of errors) {
    process.stderr.write(`${error}\n`);
  }
  process.exit(1);
}
process.stdout.write('production config checks passed\n');
