import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const token = process.env.BSL_MESH_TOKEN ?? 'bslm_agt_example';
const client = new Client(
  { name: 'bslmesh-example', version: '0.1.0' },
  { versionNegotiation: { mode: { pin: '2026-07-28' } } },
);
const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3000/mcp'), {
  requestInit: { headers: { authorization: `Bearer ${token}` } },
});

await client.connect(transport);
console.log(client.getProtocolEra());
console.log((await client.listTools()).tools.map((tool) => tool.name));
await client.close();
