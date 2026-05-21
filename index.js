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

if (!INGEST_SECRET) {
  console.error('Missing RAILWAY_INGEST_SECRET environment variable');
  process.exit(1);
}

// In-memory storage for packages
const packages = new Map();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'covered-scope-mcp',
    packages_count: packages.size 
  });
});

// Package ingest endpoint
app.post('/packages', (req, res) => {
  // Verify shared secret
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${INGEST_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const scopeData = req.body;

  // Validate required fields
  if (!scopeData.jobInfo || !scopeData.jobInfo.clientName) {
    return res.status(400).json({ error: 'Invalid scope data: missing jobInfo.clientName' });
  }

  // Generate package ID
  const packageId = 'pkg_' + crypto.randomBytes(8).toString('hex');

  // Store package with metadata
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

// MCP SSE endpoint
app.get('/sse', async (req, res) => {
  console.log('New MCP SSE connection established');
  
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

  // Tool definitions
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'list_scope_packages',
          description: 'Lists all available scope packages ready for estimate generation, ordered by most recent first',
          inputSchema: {
            type: 'object',
            properties: {
              limit: {
                type: 'number',
                description: 'Maximum number of packages to return (default 20)',
                default: 20
              }
            },
          },
        },
        {
          name: 'get_scope_package',
          description: 'Retrieves the full scope JSON for a specific package by package ID, client name, or job ID',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Package ID (pkg_xxx), client name, or job ID to search for',
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

  // Tool execution
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      if (name === 'list_scope_packages') {
        const limit = args.limit || 20;
        
        // Convert packages to array and sort by created_at
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
          content: [
            {
              type: 'text',
              text: JSON.stringify(packageList, null, 2),
            },
          ],
        };
      }

      if (name === 'get_scope_package') {
        const query = args.query.toLowerCase();

        // Search by package ID first (exact match)
        if (query.startsWith('pkg_')) {
          const pkg = packages.get(query);
          if (pkg) {
            return {
              content: [
                {
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
                },
              ],
            };
          }
        }

        // Search by client name or job ID (fuzzy)
        const matchedPkg = Array.from(packages.values()).find(pkg => 
          pkg.client_name.toLowerCase().includes(query) ||
          (pkg.job_id && pkg.job_id.toLowerCase().includes(query))
        );

        if (!matchedPkg) {
          return {
            content: [
              {
                type: 'text',
                text: `No scope package found matching "${args.query}". Try listing packages first with list_scope_packages.`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                package_metadata: {
                  package_id: matchedPkg.id,
                  client_name: matchedPkg.client_name,
                  damage_type: matchedPkg.damage_type,
                  created_at: matchedPkg.created_at
                },
                scope_data: matchedPkg.scope_data,
              }, null, 2),
            },
          ],
        };
      }

      if (name === 'get_latest_scope') {
        if (packages.size === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'No scope packages are currently available. Ask the PM to export a scope first.',
              },
            ],
          };
        }

        // Get most recent package
        const latestPkg = Array.from(packages.values())
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];

        return {
          content: [
            {
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
            },
          ],
        };
      }

      throw new Error(`Unknown tool: ${name}`);
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  });

  await server.connect(transport);
  
  req.on('close', () => {
    console.log('MCP SSE connection closed');
  });
});

// Message endpoint for POST requests
app.post('/messages', (req, res) => {
  res.status(200).send();
});

app.listen(PORT, () => {
  console.log(`Covered Scope MCP server running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`Ingest: POST http://localhost:${PORT}/packages`);
  console.log(`MCP SSE: http://localhost:${PORT}/sse`);
});
