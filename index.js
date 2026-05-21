import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { z } from 'zod';

const INGEST_SECRET = process.env.RAILWAY_INGEST_SECRET;
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : `http://localhost:${PORT}`;

if (!INGEST_SECRET) {
  console.error('❌ Missing RAILWAY_INGEST_SECRET environment variable');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// In-memory package store
// ---------------------------------------------------------------------------
const packages = new Map();

// ---------------------------------------------------------------------------
// Active sessions — keyed by sessionId
// ---------------------------------------------------------------------------
const sessions = new Map(); // sessionId -> { transport, server }

// ---------------------------------------------------------------------------
// Factory: create a fresh McpServer with all tools registered
// ---------------------------------------------------------------------------
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
      const packageList = Array.from(packages.values())
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, limit)
        .map((pkg) => ({
          package_id: pkg.id,
          client_name: pkg.client_name,
          address: pkg.address,
          damage_type: pkg.damage_type,
          date_of_loss: pkg.date_of_loss,
          job_id: pkg.job_id,
          created_at: pkg.created_at,
          status: pkg.status,
        }));
      console.log(`   📋 Returning ${packageList.length} packages`);
      return { content: [{ type: 'text', text: JSON.stringify(packageList, null, 2) }] };
    }
  );

  server.tool(
    'get_scope_package',
    'Retrieves the full scope JSON for a package by ID, client name, or job ID',
    { query: z.string().describe('Package ID, client name, or job ID to search for') },
    async ({ query }) => {
      console.log(`✅ get_scope_package called: ${query}`);
      const q = query.toLowerCase();
      let pkg = q.startsWith('pkg_')
        ? packages.get(q)
        : Array.from(packages.values()).find(
            (p) =>
              p.client_name.toLowerCase().includes(q) ||
              (p.job_id && p.job_id.toLowerCase().includes(q))
          );

      if (!pkg) {
        return { content: [{ type: 'text', text: `No package found matching "${query}"` }] };
      }

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
    }
  );

  server.tool(
    'get_latest_scope',
    'Retrieves the most recently created scope package',
    {},
    async () => {
      console.log('✅ get_latest_scope called');
      if (packages.size === 0) {
        return { content: [{ type: 'text', text: 'No scope packages available' }] };
      }
      const latestPkg = Array.from(packages.values()).sort(
        (a, b) => new Date(b.created_at) - new Date(a.created_at)
      )[0];
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            package_metadata: {
              package_id: latestPkg.id,
              client_name: latestPkg.client_name,
              damage_type: latestPkg.damage_type,
              created_at: latestPkg.created_at,
            },
            scope_data: latestPkg.scope_data,
          }, null, 2),
        }],
      };
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Mcp-Session-Id'],
  exposedHeaders: ['Mcp-Session-Id'],
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'covered-scope-mcp',
    packages_count: packages.size,
    active_sessions: sessions.size,
    authentication: 'none',
    base_url: BASE_URL,
  });
});

// ---------------------------------------------------------------------------
// Package ingest
// ---------------------------------------------------------------------------
app.post('/packages', (req, res) => {
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
  packages.set(packageId, {
    id: packageId,
    created_at: new Date().toISOString(),
    client_name: scopeData.jobInfo.clientName,
    address: `${scopeData.jobInfo.address || ''}, ${scopeData.jobInfo.city || ''}, ${scopeData.jobInfo.state || ''}`,
    damage_type: scopeData.jobInfo.damageType || 'unknown',
    date_of_loss: scopeData.jobInfo.dateOfLoss || null,
    job_id: scopeData.jobInfo.jobId || null,
    scope_data: scopeData,
    status: 'ready',
  });

  console.log(`📦 Package created: ${packageId} for ${scopeData.jobInfo.clientName}`);
  res.status(201).json({
    success: true,
    package_id: packageId,
    client_name: scopeData.jobInfo.clientName,
    damage_type: scopeData.jobInfo.damageType,
  });
});

// ---------------------------------------------------------------------------
// MCP endpoint — Streamable HTTP (POST to init, GET for SSE stream, DELETE to close)
// ---------------------------------------------------------------------------

// POST /mcp — initialize new session or handle message on existing session
app.post('/mcp', async (req, res) => {
  console.log('🔵 MCP POST from:', req.headers['user-agent']);
  const sessionId = req.headers['mcp-session-id'];

  // Resume existing session
  if (sessionId && sessions.has(sessionId)) {
    console.log(`📨 Message on existing session: ${sessionId}`);
    const { transport } = sessions.get(sessionId);
    await transport.handleRequest(req, res);
    return;
  }

  // New session
  if (!sessionId) {
    console.log('🆕 New MCP session initializing...');

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server });
        console.log(`✅ Session initialized: ${id}`);
      },
    });

    const server = createMcpServer();

    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
        console.log(`🔴 Session closed: ${transport.sessionId}`);
      }
    };

    await server.connect(transport);
    await transport.handleRequest(req, res);
    return;
  }

  console.warn(`⚠️  POST with unknown sessionId: ${sessionId}`);
  res.status(404).json({ error: 'Session not found' });
});

// GET /mcp — open SSE stream for an existing session
app.get('/mcp', async (req, res) => {
  console.log('🔵 MCP GET from:', req.headers['user-agent']);
  const sessionId = req.headers['mcp-session-id'];

  if (!sessionId || !sessions.has(sessionId)) {
    console.warn(`⚠️  GET with unknown sessionId: ${sessionId}`);
    return res.status(404).json({ error: 'Session not found' });
  }

  console.log(`📡 Opening SSE stream for session: ${sessionId}`);
  const { transport } = sessions.get(sessionId);
  await transport.handleRequest(req, res);
});

// DELETE /mcp — close a session
app.delete('/mcp', async (req, res) => {
  console.log('🔵 MCP DELETE from:', req.headers['user-agent']);
  const sessionId = req.headers['mcp-session-id'];

  if (!sessionId || !sessions.has(sessionId)) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const { transport } = sessions.get(sessionId);
  await transport.handleRequest(req, res);
  sessions.delete(sessionId);
  console.log(`🗑️  Session deleted: ${sessionId}`);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log('\n' + '='.repeat(60));
  console.log('🚀 Covered Scope MCP Server READY');
  console.log('='.repeat(60));
  console.log(`📍 Port:        ${PORT}`);
  console.log(`🌐 Base URL:    ${BASE_URL}`);
  console.log(`❤️  Health:      ${BASE_URL}/health`);
  console.log(`🔌 MCP:         ${BASE_URL}/mcp`);
  console.log(`📦 Packages:    ${BASE_URL}/packages`);
  console.log('='.repeat(60) + '\n');
});
