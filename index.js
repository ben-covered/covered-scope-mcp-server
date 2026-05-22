import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { z } from 'zod';
import pg from 'pg';

const { Pool } = pg;

const INGEST_SECRET = process.env.RAILWAY_INGEST_SECRET;
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : `http://localhost:${PORT}`;

if (!INGEST_SECRET) {
  console.error('❌ Missing RAILWAY_INGEST_SECRET environment variable');
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error('❌ Missing DATABASE_URL environment variable');
  process.exit(1);
}

// Postgres connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false,
});

// Initialize database table
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scope_packages (
      id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      client_name TEXT NOT NULL,
      address TEXT,
      damage_type TEXT,
      date_of_loss TEXT,
      job_id TEXT,
      scope_data JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'ready'
    )
  `);
  console.log('✅ Database initialized');
}

// Factory: create a fresh McpServer with all tools registered
function createMcpServer() {
  const server = new McpServer(
    { name: 'covered-scope-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.tool(
    'list_scope_packages',
    'Lists all available scope packages ready for estimate generation',
    { limit: z.number().optional().describe('Maximum number of packages to return') },
    async ({ limit = 20 }) => {
      console.log('✅ list_scope_packages called');
      try {
        const result = await pool.query(
          `SELECT id, created_at, client_name, address, damage_type, date_of_loss, job_id, status
           FROM scope_packages
           ORDER BY created_at DESC
           LIMIT $1`,
          [limit]
        );
        const packageList = result.rows.map((row) => ({
          package_id: row.id,
          client_name: row.client_name,
          address: row.address,
          damage_type: row.damage_type,
          date_of_loss: row.date_of_loss,
          job_id: row.job_id,
          created_at: row.created_at,
          status: row.status,
        }));
        console.log(`   📋 Returning ${packageList.length} packages`);
        return { content: [{ type: 'text', text: JSON.stringify(packageList, null, 2) }] };
      } catch (err) {
        console.error(`❌ list_scope_packages DB error: ${err.message}`);
        return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  server.tool(
    'get_scope_package',
    'Retrieves the full scope JSON for a package by ID, client name, or job ID',
    { query: z.string().describe('Package ID, client name, or job ID to search for') },
    async ({ query }) => {
      console.log(`✅ get_scope_package called: ${query}`);
      try {
        const q = query.toLowerCase();
        let result;

        if (q.startsWith('pkg_')) {
          result = await pool.query(
            'SELECT * FROM scope_packages WHERE id = $1',
            [q]
          );
        } else {
          result = await pool.query(
            `SELECT * FROM scope_packages
             WHERE LOWER(client_name) LIKE $1 OR LOWER(job_id) LIKE $1
             ORDER BY created_at DESC LIMIT 1`,
            [`%${q}%`]
          );
        }

        if (result.rows.length === 0) {
          return { content: [{ type: 'text', text: `No package found matching "${query}"` }] };
        }

        const pkg = result.rows[0];
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              package_metadata: {
                package_id: pkg.id,
                client_name: pkg.client_name,
                damage_type: pkg.damage_type,
                created_at: pkg.created_at,
              },
              scope_data: pkg.scope_data,
            }, null, 2),
          }],
        };
      } catch (err) {
        console.error(`❌ get_scope_package DB error: ${err.message}`);
        return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  server.tool(
    'get_latest_scope',
    'Retrieves the most recently created scope package',
    {},
    async () => {
      console.log('✅ get_latest_scope called');
      try {
        const result = await pool.query(
          'SELECT * FROM scope_packages ORDER BY created_at DESC LIMIT 1'
        );

        if (result.rows.length === 0) {
          return { content: [{ type: 'text', text: 'No scope packages available' }] };
        }

        const pkg = result.rows[0];
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              package_metadata: {
                package_id: pkg.id,
                client_name: pkg.client_name,
                damage_type: pkg.damage_type,
                created_at: pkg.created_at,
              },
              scope_data: pkg.scope_data,
            }, null, 2),
          }],
        };
      } catch (err) {
        console.error(`❌ get_latest_scope DB error: ${err.message}`);
        return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  return server;
}

// Express app
const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Mcp-Session-Id'],
  exposedHeaders: ['Mcp-Session-Id'],
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));

// Health
app.get('/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*) FROM scope_packages');
    res.json({
      status: 'ok',
      service: 'covered-scope-mcp',
      packages_count: parseInt(result.rows[0].count),
      authentication: 'none',
      base_url: BASE_URL,
      storage: 'postgres',
      mode: 'stateless',
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Package ingest
app.post('/packages', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${INGEST_SECRET}`) {
    console.log('❌ Unauthorized package ingest attempt');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const scopeData = req.body;
  if (!scopeData.jobInfo || !scopeData.jobInfo.clientName) {
    console.log('❌ Invalid scope data received');
    return res.status(400).json({ error: 'Invalid scope data: missing jobInfo.clientName' });
  }

  const packageId = 'pkg_' + crypto.randomBytes(8).toString('hex');

  await pool.query(
    `INSERT INTO scope_packages (id, client_name, address, damage_type, date_of_loss, job_id, scope_data, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'ready')`,
    [
      packageId,
      scopeData.jobInfo.clientName,
      `${scopeData.jobInfo.address || ''}, ${scopeData.jobInfo.city || ''}, ${scopeData.jobInfo.state || ''}`,
      scopeData.jobInfo.damageType || 'unknown',
      scopeData.jobInfo.dateOfLoss || null,
      scopeData.jobInfo.jobId || null,
      JSON.stringify(scopeData),
    ]
  );

  console.log(`📦 Package created: ${packageId} for ${scopeData.jobInfo.clientName}`);
  res.status(201).json({
    success: true,
    packageId: packageId,
    package_id: packageId,
    client_name: scopeData.jobInfo.clientName,
    damage_type: scopeData.jobInfo.damageType,
  });
});

// POST /mcp — stateless: each request is independent, no session required
app.post('/mcp', async (req, res) => {
  console.log('🔵 MCP POST from:', req.headers['user-agent']);
  console.log(`   Method: ${req.body?.method || 'unknown'}`);

  try {
    // Create a fresh transport for this request only
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });

    // Create a fresh server instance
    const server = createMcpServer();

    // Connect server to transport
    await server.connect(transport);

    // Handle the incoming request
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('❌ MCP POST error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error', data: err.message },
        id: req.body?.id || null,
      });
    }
  }
});

// Start
initDb().then(() => {
  app.listen(PORT, () => {
    console.log('\n' + '='.repeat(60));
    console.log('🚀 Covered Scope MCP Server READY');
    console.log('='.repeat(60));
    console.log(`📍 Port:        ${PORT}`);
    console.log(`🌐 Base URL:    ${BASE_URL}`);
    console.log(`❤️  Health:      ${BASE_URL}/health`);
    console.log(`🔌 MCP:         ${BASE_URL}/mcp`);
    console.log(`📦 Packages:    ${BASE_URL}/packages`);
    console.log(`🗄️  Storage:     PostgreSQL`);
    console.log(`🔄 Mode:        Stateless (no session management)`);
    console.log('='.repeat(60) + '\n');
  });
}).catch((err) => {
  console.error('❌ Failed to initialize database:', err);
  process.exit(1);
});
