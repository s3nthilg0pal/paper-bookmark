const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const Datastore = require('nedb-promises');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// Create HTTP server for both Express and WebSocket
const server = http.createServer(app);

// Initialize WebSocket server on specific path for better proxy compatibility
const wss = new WebSocket.Server({ server, path: '/ws' });

// Track connected clients
const clients = new Set();

wss.on('connection', (ws, req) => {
  clients.add(ws);
  console.log(`📱 Client connected from ${req.headers['x-forwarded-for'] || req.socket.remoteAddress}. Total: ${clients.size}`);
  
  // Send a ping to confirm connection
  ws.send(JSON.stringify({ event: 'connected', data: { clientCount: clients.size } }));
  
  ws.on('close', () => {
    clients.delete(ws);
    console.log(`📱 Client disconnected. Total clients: ${clients.size}`);
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    clients.delete(ws);
  });
  
  // Handle ping/pong for connection keep-alive (important for Cloudflare)
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
});

// Ping all clients every 30 seconds to keep connections alive through proxies
const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      clients.delete(ws);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(pingInterval);
});

// Broadcast update to all connected clients
function broadcast(event, data) {
  const message = JSON.stringify({ event, data });
  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// Initialize NeDB database
const db = Datastore.create({
  filename: path.join(__dirname, 'data', 'papers.db'),
  autoload: true
});

// Create index on url for faster lookups
db.ensureIndex({ fieldName: 'url', unique: true });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============== API ROUTES ==============

// GET all papers
app.get('/api/papers', async (req, res) => {
  try {
    const { search, tag, sort = 'dateAdded', order = 'desc' } = req.query;
    
    let query = {};
    
    // Search filter
    if (search) {
      const searchRegex = new RegExp(search, 'i');
      query = {
        $or: [
          { title: searchRegex },
          { authors: searchRegex },
          { abstract: searchRegex },
          { tags: searchRegex }
        ]
      };
    }
    
    // Tag filter
    if (tag) {
      query.tags = tag;
    }
    
    const sortOrder = order === 'asc' ? 1 : -1;
    const papers = await db.find(query).sort({ [sort]: sortOrder });
    
    res.json({ success: true, data: papers });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET single paper by ID
app.get('/api/papers/:id', async (req, res) => {
  try {
    const paper = await db.findOne({ _id: req.params.id });
    
    if (!paper) {
      return res.status(404).json({ success: false, error: 'Paper not found' });
    }
    
    res.json({ success: true, data: paper });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST new paper
app.post('/api/papers', async (req, res) => {
  try {
    const { url, title, authors, abstract, tags, source } = req.body;
    
    if (!url) {
      return res.status(400).json({ success: false, error: 'URL is required' });
    }
    
    // Check if paper already exists
    const existing = await db.findOne({ url });
    if (existing) {
      return res.status(409).json({ success: false, error: 'Paper already exists', data: existing });
    }
    
    const paper = {
      url,
      title: title || 'Untitled Paper',
      authors: authors || '',
      abstract: abstract || '',
      tags: tags || [],
      source: source || detectSource(url),
      dateAdded: new Date().toISOString(),
      lastAccessed: null,
      accessCount: 0
    };
    
    const newPaper = await db.insert(paper);
    
    // Broadcast to all connected clients
    broadcast('paper:created', newPaper);
    
    res.status(201).json({ success: true, data: newPaper });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT update paper
app.put('/api/papers/:id', async (req, res) => {
  try {
    const { title, authors, abstract, tags, url } = req.body;
    
    const updateData = {
      ...(title && { title }),
      ...(authors !== undefined && { authors }),
      ...(abstract !== undefined && { abstract }),
      ...(tags && { tags }),
      ...(url && { url, source: detectSource(url) })
    };
    
    const numUpdated = await db.update(
      { _id: req.params.id },
      { $set: updateData },
      { returnUpdatedDocs: true }
    );
    
    if (numUpdated === 0) {
      return res.status(404).json({ success: false, error: 'Paper not found' });
    }
    
    const updatedPaper = await db.findOne({ _id: req.params.id });
    
    // Broadcast to all connected clients
    broadcast('paper:updated', updatedPaper);
    
    res.json({ success: true, data: updatedPaper });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE paper
app.delete('/api/papers/:id', async (req, res) => {
  try {
    const numRemoved = await db.remove({ _id: req.params.id });
    
    if (numRemoved === 0) {
      return res.status(404).json({ success: false, error: 'Paper not found' });
    }
    
    // Broadcast to all connected clients
    broadcast('paper:deleted', { _id: req.params.id });
    
    res.json({ success: true, message: 'Paper deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Track paper access (when user clicks to open)
app.post('/api/papers/:id/access', async (req, res) => {
  try {
    await db.update(
      { _id: req.params.id },
      { 
        $set: { lastAccessed: new Date().toISOString() },
        $inc: { accessCount: 1 }
      }
    );
    
    const paper = await db.findOne({ _id: req.params.id });
    res.json({ success: true, data: paper });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET all unique tags
app.get('/api/tags', async (req, res) => {
  try {
    const papers = await db.find({});
    const tagsSet = new Set();
    
    papers.forEach(paper => {
      if (paper.tags && Array.isArray(paper.tags)) {
        paper.tags.forEach(tag => tagsSet.add(tag));
      }
    });
    
    res.json({ success: true, data: Array.from(tagsSet).sort() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Fetch paper metadata from URL (for arxiv, doi, etc.)
app.post('/api/fetch-metadata', async (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ success: false, error: 'URL is required' });
    }
    
    const metadata = await fetchPaperMetadata(url);
    res.json({ success: true, data: metadata });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============== HELPER FUNCTIONS ==============

function detectSource(url) {
  if (url.includes('arxiv.org')) return 'arXiv';
  if (url.includes('doi.org')) return 'DOI';
  if (url.includes('ieee.org')) return 'IEEE';
  if (url.includes('acm.org')) return 'ACM';
  if (url.includes('springer.com')) return 'Springer';
  if (url.includes('nature.com')) return 'Nature';
  if (url.includes('sciencedirect.com')) return 'ScienceDirect';
  if (url.includes('ncbi.nlm.nih.gov') || url.includes('pubmed')) return 'PubMed';
  if (url.includes('semanticscholar.org')) return 'Semantic Scholar';
  if (url.includes('openreview.net')) return 'OpenReview';
  if (url.includes('github.com')) return 'GitHub';
  return 'Web';
}

async function fetchPaperMetadata(url) {
  const source = detectSource(url);
  
  try {
    // Handle arXiv papers
    if (source === 'arXiv') {
      return await fetchArxivMetadata(url);
    }
    
    // For other sources, return basic info
    return {
      url,
      title: '',
      authors: '',
      abstract: '',
      source
    };
  } catch (error) {
    console.error('Error fetching metadata:', error);
    return {
      url,
      title: '',
      authors: '',
      abstract: '',
      source
    };
  }
}

async function fetchArxivMetadata(url) {
  // Extract arXiv ID from URL
  const arxivIdMatch = url.match(/(?:arxiv.org\/(?:abs|pdf)\/|arxiv:)(\d+\.\d+)/i);
  
  if (!arxivIdMatch) {
    return { url, title: '', authors: '', abstract: '', source: 'arXiv' };
  }
  
  const arxivId = arxivIdMatch[1];
  const apiUrl = `http://export.arxiv.org/api/query?id_list=${arxivId}`;
  
  const response = await fetch(apiUrl);
  const xmlText = await response.text();
  
  // Simple XML parsing for arXiv API response
  const titleMatch = xmlText.match(/<title>([\s\S]*?)<\/title>/g);
  const title = titleMatch && titleMatch[1] 
    ? titleMatch[1].replace(/<\/?title>/g, '').trim().replace(/\s+/g, ' ')
    : '';
  
  const authorMatches = xmlText.match(/<name>([\s\S]*?)<\/name>/g);
  const authors = authorMatches 
    ? authorMatches.map(a => a.replace(/<\/?name>/g, '').trim()).join(', ')
    : '';
  
  const summaryMatch = xmlText.match(/<summary>([\s\S]*?)<\/summary>/);
  const abstract = summaryMatch 
    ? summaryMatch[1].trim().replace(/\s+/g, ' ')
    : '';
  
  return {
    url,
    title,
    authors,
    abstract,
    source: 'arXiv'
  };
}

// Serve frontend for all non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server (use 'server' instead of 'app' for WebSocket support)
server.listen(PORT, () => {
  console.log(`📚 Paper Bookmark server running on http://localhost:${PORT}`);
  console.log(`🔄 WebSocket server ready for real-time sync`);
});
