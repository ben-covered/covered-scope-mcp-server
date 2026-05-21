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

// OAuth Protected Resource Metadata (RFC 9728) - Declares authless
app.get('/.well-known/oauth-protected-resource', (req, res) => {
  console.log('OAuth protected resource metadata requested');
  res.json({
    resource: BASE_URL,
    authorization_servers: [],
    bearer_methods_supported: ["header"],
    resource_documentation: `${BASE_URL}/health`,
    scopes_supported: [],
    grant_types_supported: ["none"]
  });
});

// OAuth Authorization Server Metadata (RFC 8414) - Also declares authless
app.get('/.well-known/oauth-authorization-server', (req, res) => {
  console.log('OAuth authorization server metadata requested');
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

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'covered-scope-mcp',
    packages_count: packages.size,
    authentication: 'none',
    base_url: BASE_URL
  });
});

// MCP Manifest endpoint
app.get('/mcp/manifest', (req, res) => {
  console.log('MCP manifest requested');
  res.json({
    name: "covered-scope-mcp",
    version: "1.0.0",
    description: "Covered Scope MCP server for restoration estimate generation",
    capabilities: {
      tools: {}
    },
    authentication: {
      type: "none"
    }
  });
});

// Root manifest endpoint (alternative)
app.get('/manifest', (req, res) => {
  console.log('Root manifest requested');
  res.json({
    name: "covered-scope-mcp",
    version: "1.0.0",
    description: "Covered Scope MCP server for restoration estimate generation",
    capabilities: {
      tools: {}
    },
    authentication: {
      type: "none"
    }
  });
});

// Package ingest endpoint (requires secret for Lovable)
app.post('/packages', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${INGEST_SECRET}`) {
    console.log('Unauthorized package ingest attempt');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const scopeData = req.body;

  if (!scopeData.jobInfo || !scopeData.jobInfo.clientName) {
    console.log('Invalid scope data received');
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
    
