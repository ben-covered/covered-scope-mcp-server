import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';

const INGEST_SECRET = process.env.RAILWAY_INGEST_SECRET;
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN 
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` 
  : `http://localhost:${PORT}`;

if (!INGEST_SECRET) {
  console.error('Missing RAILWAY_INGEST_SECRET environment variable');
  process.exit(1);
}

const packages = new Map();
const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));

app.get('/.well-known/oauth-protected-resource', (req, res) => {
  res.json({
    resource: BASE_URL,
    authorization_servers: [],
    bearer_methods_supported: ["header"],
    resource_documentation: `${BASE_URL}/health`,
    scopes_supported: [],
    grant_types_supported: ["none"]
  });
});

app.get('/.well-known/oauth-authorization-server', (req, res) => {
  res.json({
    issuer: BASE_URL,
    authorization_endpoint: "",
    token_endpoint: "",
    grant_types_supported: ["none"],
    response_types_supported: [],
    scopes_supported: [],
    token_endpoint_auth_methods_supported: ["none"]
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'covered-scope-mcp',
    packages_count: packages.size,
    authentication: 'none',
    base_url: BASE_URL
  });
});

app.post('/packages', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${INGEST_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const scopeData = req.body;
  if (!scopeData.jobInfo || !scopeData.jobInfo.clientName) {
    return res.status(400).json({ error: 'Invalid scope data: missing jobInfo.clientName' });
  }

  const packageId = 'pkg_' + crypto.randomBytes(8).toString('hex');
  packages.set(packageId, {
    id: packageId,
    created_at: new Date().toISOString(),
    client_name: scopeData.jobInfo.clientName,
    address: `${scopeData.jobInfo.address || ''}, ${scopeData.jobInfo.city || ''}, ${scopeData.jobInfo.state || ''}`,
    damage_type: scopeData.jobInfo.damageType || 'unknown',
    date_of_loss: scopeData.jobInfo.dateOfLoss || null,
    job_id: scopeData.jobInfo.jobId || null,
    scope_data: scopeData,
    status: 'ready'
  });

  console.log(`Package created: ${packageId} for ${scopeData.jobInfo.clientName}`);
  res.status(201).json({
    success: true,
    package_id: packageId,
    client_name: scopeData.jobInfo.clientName,
    damage_type: scopeData.jobInfo.damageType
  });
});

app.get('/sse', async (req, res) => {
  console.log('MCP SSE connection from:', req.headers['user-agent']);
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Accel-Buffering', 'no');
  
  const transport = new SSEServerTransport('/messages', res);
  const server = new Server(
    {
      name: 'covered-scope-mcp',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    console.log('ListTools request received');
    return {
      tools: [
        {
          name: 'list_scope_packages',
          description: 'Lists all available scope packages ready for estimate generation',
          inputSchema: {
            type: 'object',
            properties: {
              limit: {
                type: 'number',
                description: 'Maximum number of packages to return',
                default: 20
              }
            },
          },
        },
        {
          name: 'get_scope_package',
          description: 'Retrieves the full scope JSON for a package by ID, client name, or job ID',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Package ID, client name, or job ID to search for',
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'get_latest_scope',
          description: 'Retrieves the most recently created scope package',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    console.log(`Tool called: ${name}`);

    try {
      if (name === 'list_scope_packages') {
        const limit = args.limit || 20;
        const packageList = Array.from(packages.values())
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
          .slice(0, limit)
          .map(pkg => ({
            package_id: pkg.id,
            client_name: pkg.client_name,
            address: pkg.address,
            damage_type: pkg.damage_type,
            date_of_loss: pkg.date_of_loss,
            job_id: pkg.job_id,
            created_at: pkg.created_at,
            status: pkg.status
          }));

        return {
          content: [{
            type: 'text',
            text: JSON.stringify(packageList, null, 2),
          }],
        };
      }

      if (name === 'get_scope_package') {
        const query = args.query.toLowerCase();
        let pkg = null;

        if (query.startsWith('pkg_')) {
          pkg = packages.get(query);
        } else {
          pkg = Array.from(packages.values()).find(p => 
            p.client_name.toLowerCase().includes(query) ||
            (p.job_id && p.job_id.toLowerCase().includes(query))
          );
        }

        if (!pkg) {
          return {
            content: [{
              type: 'text',
              text: `No package found matching "${args.query}"`,
            }],
          };
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              package_metadata: {
                package_id: pkg.id,
                client_name: pkg.client_name,
                damage_type: pkg.damage_type,
                created_at: pkg.created_at
              },
              scope_data: pkg.scope_data,
            }, null, 2),
          }],
        };
      }

      if (name === 'get_latest_scope') {
        if (packages.size === 0) {
          return {
            content: [{
              type: 'text',
              text: 'No scope packages available',
            }],
          };
        }

        const latestPkg = Array.from(packages.values())
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              package_metadata: {
                package_id: latestPkg.id,
                client_name: latestPkg.client_name,
                damage_type: latestPkg.damage_type,
                created_at: latestPkg.created_at
              },
              scope_data: latestPkg.scope_data,
            }, null, 2),
          }],
        };
      }

      throw new Error(`Unknown tool: ${name}`);
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `Error: ${error.message}`,
        }],
        isError: true,
      };
    }
  });

  await server.connect(transport);
  console.log('MCP connection established');
  
  req.on('close', () => {
    console.log('MCP connection closed');
  });
});

app.post('/messages', express.json(), async (req, res) => {
  res.status(200).send();
});

app.listen(PORT, () => {
  console.log(`Covered Scope MCP server running on port ${PORT}`);
  console.log(`Health: ${BASE_URL}/health`);
  console.log(`MCP SSE: ${BASE_URL}/sse`);
});
