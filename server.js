const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const http = require('http');
const fs = require('fs');
const WebSocket = require('ws');
const Loki = require('lokijs');
const { v4: uuidv4 } = require('uuid');
const validator = require('validator');
const fetch = require('node-fetch');

// ============== CONFIGURATION ==============
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const CORS_ORIGINS = process.env.CORS_ORIGINS || '*';
const RATE_LIMIT_WINDOW = parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100;
const DB_AUTOSAVE_INTERVAL = parseInt(process.env.DB_AUTOSAVE_INTERVAL) || 5000;

const app = express();

// ============== SECURITY MIDDLEWARE ==============

// Helmet - Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "ws:", "wss:"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// CORS configuration
const corsOptions = {
  origin: CORS_ORIGINS === '*' ? '*' : CORS_ORIGINS.split(',').map(o => o.trim()),
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type'],
  credentials: true,
};
app.use(cors(corsOptions));

// Rate limiting
const limiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW,
  max: RATE_LIMIT_MAX,
  message: { success: false, error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Body parser with size limit
app.use(express.json({ limit: '1mb' }));

// ============== DATABASE SETUP (LokiJS) ==============

// Ensure data directory exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let db;
let papers;

const initDatabase = () => {
  return new Promise((resolve) => {
    db = new Loki(path.join(dataDir, 'papers.db'), {
      autoload: true,
      autoloadCallback: () => {
        papers = db.getCollection('papers');
        if (!papers) {
          papers = db.addCollection('papers', {
            unique: ['id'],
            indices: ['url', 'dateAdded']
          });
        }
        console.log('📦 Database loaded successfully');
        resolve();
      },
      autosave: true,
      autosaveInterval: DB_AUTOSAVE_INTERVAL,
    });
  });
};

// ============== HTTP & WEBSOCKET SERVER ==============

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });
const clients = new Set();

wss.on('connection', (ws, req) => {
  clients.add(ws);
  console.log(`📱 Client connected from ${req.headers['x-forwarded-for'] || req.socket.remoteAddress}. Total: ${clients.size}`);
  
  ws.send(JSON.stringify({ event: 'connected', data: { clientCount: clients.size } }));
  
  ws.on('close', () => {
    clients.delete(ws);
    console.log(`📱 Client disconnected. Total: ${clients.size}`);
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    clients.delete(ws);
  });
  
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
});

// Ping clients every 30 seconds for keep-alive
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

wss.on('close', () => clearInterval(pingInterval));

function broadcast(event, data) {
  const message = JSON.stringify({ event, data });
  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// ============== INPUT VALIDATION & SANITIZATION ==============

function sanitizeString(str, maxLength = 10000) {
  if (!str || typeof str !== 'string') return '';
  return validator.escape(validator.trim(str)).substring(0, maxLength);
}

function validateUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return validator.isURL(url, {
    protocols: ['http', 'https'],
    require_protocol: true,
  });
}

function sanitizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags
    .filter(tag => typeof tag === 'string')
    .map(tag => validator.escape(validator.trim(tag.toLowerCase())).substring(0, 50))
    .filter(tag => tag.length > 0)
    .slice(0, 20); // Max 20 tags
}

function validatePaperInput(body) {
  const errors = [];
  
  if (!body.url) {
    errors.push('URL is required');
  } else if (!validateUrl(body.url)) {
    errors.push('Invalid URL format');
  }
  
  if (body.title && body.title.length > 500) {
    errors.push('Title must be less than 500 characters');
  }
  
  if (body.authors && body.authors.length > 1000) {
    errors.push('Authors must be less than 1000 characters');
  }
  
  if (body.abstract && body.abstract.length > 10000) {
    errors.push('Abstract must be less than 10000 characters');
  }
  
  return errors;
}

// ============== STATIC FILES ==============

app.use(express.static(path.join(__dirname, 'public')));

// ============== API ROUTES ==============

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: require('./package.json').version,
  });
});

// GET all papers
app.get('/api/papers', (req, res) => {
  try {
    const { search, tag, sort = 'dateAdded', order = 'desc' } = req.query;
    
    let results = papers.chain();
    
    // Search filter
    if (search) {
      const searchLower = search.toLowerCase();
      results = results.where((paper) => {
        return (
          (paper.title && paper.title.toLowerCase().includes(searchLower)) ||
          (paper.authors && paper.authors.toLowerCase().includes(searchLower)) ||
          (paper.abstract && paper.abstract.toLowerCase().includes(searchLower)) ||
          (paper.tags && paper.tags.some(t => t.includes(searchLower)))
        );
      });
    }
    
    // Tag filter
    if (tag) {
      results = results.where((paper) => paper.tags && paper.tags.includes(tag));
    }
    
    // Sort
    const isDescending = order === 'desc';
    results = results.simplesort(sort, { desc: isDescending });
    
    const data = results.data().map(sanitizePaperOutput);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching papers:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET single paper by ID
app.get('/api/papers/:id', (req, res) => {
  try {
    const paper = papers.findOne({ id: req.params.id });
    
    if (!paper) {
      return res.status(404).json({ success: false, error: 'Paper not found' });
    }
    
    res.json({ success: true, data: sanitizePaperOutput(paper) });
  } catch (error) {
    console.error('Error fetching paper:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST new paper
app.post('/api/papers', (req, res) => {
  try {
    const validationErrors = validatePaperInput(req.body);
    if (validationErrors.length > 0) {
      return res.status(400).json({ success: false, errors: validationErrors });
    }
    
    const { url, title, authors, abstract, tags, source } = req.body;
    
    // Check if paper already exists
    const existing = papers.findOne({ url: url });
    if (existing) {
      return res.status(409).json({
        success: false,
        error: 'Paper already exists',
        data: sanitizePaperOutput(existing)
      });
    }
    
    const paper = {
      id: uuidv4(),
      url: url,
      title: sanitizeString(title, 500) || 'Untitled Paper',
      authors: sanitizeString(authors, 1000),
      abstract: sanitizeString(abstract, 10000),
      tags: sanitizeTags(tags || []),
      source: source || detectSource(url),
      dateAdded: new Date().toISOString(),
      lastAccessed: null,
      accessCount: 0,
    };
    
    papers.insert(paper);
    db.saveDatabase();
    
    const outputPaper = sanitizePaperOutput(paper);
    broadcast('paper:created', outputPaper);
    
    res.status(201).json({ success: true, data: outputPaper });
  } catch (error) {
    console.error('Error creating paper:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// PUT update paper
app.put('/api/papers/:id', (req, res) => {
  try {
    const paper = papers.findOne({ id: req.params.id });
    
    if (!paper) {
      return res.status(404).json({ success: false, error: 'Paper not found' });
    }
    
    const { title, authors, abstract, tags, url } = req.body;
    
    // Validate URL if provided
    if (url && !validateUrl(url)) {
      return res.status(400).json({ success: false, error: 'Invalid URL format' });
    }
    
    // Update fields
    if (title !== undefined) paper.title = sanitizeString(title, 500);
    if (authors !== undefined) paper.authors = sanitizeString(authors, 1000);
    if (abstract !== undefined) paper.abstract = sanitizeString(abstract, 10000);
    if (tags !== undefined) paper.tags = sanitizeTags(tags);
    if (url) {
      paper.url = url;
      paper.source = detectSource(url);
    }
    
    papers.update(paper);
    db.saveDatabase();
    
    const outputPaper = sanitizePaperOutput(paper);
    broadcast('paper:updated', outputPaper);
    
    res.json({ success: true, data: outputPaper });
  } catch (error) {
    console.error('Error updating paper:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// DELETE paper
app.delete('/api/papers/:id', (req, res) => {
  try {
    const paper = papers.findOne({ id: req.params.id });
    
    if (!paper) {
      return res.status(404).json({ success: false, error: 'Paper not found' });
    }
    
    papers.remove(paper);
    db.saveDatabase();
    
    broadcast('paper:deleted', { id: req.params.id });
    
    res.json({ success: true, message: 'Paper deleted successfully' });
  } catch (error) {
    console.error('Error deleting paper:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Track paper access
app.post('/api/papers/:id/access', (req, res) => {
  try {
    const paper = papers.findOne({ id: req.params.id });
    
    if (!paper) {
      return res.status(404).json({ success: false, error: 'Paper not found' });
    }
    
    paper.lastAccessed = new Date().toISOString();
    paper.accessCount = (paper.accessCount || 0) + 1;
    
    papers.update(paper);
    db.saveDatabase();
    
    res.json({ success: true, data: sanitizePaperOutput(paper) });
  } catch (error) {
    console.error('Error tracking access:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET all unique tags
app.get('/api/tags', (req, res) => {
  try {
    const allPapers = papers.find();
    const tagsSet = new Set();
    
    allPapers.forEach(paper => {
      if (paper.tags && Array.isArray(paper.tags)) {
        paper.tags.forEach(tag => tagsSet.add(tag));
      }
    });
    
    res.json({ success: true, data: Array.from(tagsSet).sort() });
  } catch (error) {
    console.error('Error fetching tags:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Fetch paper metadata
app.post('/api/fetch-metadata', (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url || !validateUrl(url)) {
      return res.status(400).json({ success: false, error: 'Valid URL is required' });
    }
    
    fetchPaperMetadata(url)
      .then(metadata => res.json({ success: true, data: metadata }))
      .catch(error => {
        console.error('Error fetching metadata:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch metadata' });
      });
  } catch (error) {
    console.error('Error in fetch-metadata:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ============== HELPER FUNCTIONS ==============

function sanitizePaperOutput(paper) {
  return {
    id: paper.id,
    _id: paper.id, // Backward compatibility
    url: paper.url,
    title: paper.title,
    authors: paper.authors,
    abstract: paper.abstract,
    tags: paper.tags,
    source: paper.source,
    dateAdded: paper.dateAdded,
    lastAccessed: paper.lastAccessed,
    accessCount: paper.accessCount,
  };
}

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
  if (url.includes('huggingface.co')) return 'HuggingFace';
  return 'Web';
}

async function fetchPaperMetadata(url) {
  const source = detectSource(url);
  
  try {
    if (source === 'arXiv') {
      return await fetchArxivMetadata(url);
    }
    
    return { url, title: '', authors: '', abstract: '', source };
  } catch (error) {
    console.error('Error fetching metadata:', error);
    return { url, title: '', authors: '', abstract: '', source };
  }
}

async function fetchArxivMetadata(url) {
  const arxivIdMatch = url.match(/(?:arxiv.org\/(?:abs|pdf)\/|arxiv:)(\d+\.\d+)/i);
  
  if (!arxivIdMatch) {
    return { url, title: '', authors: '', abstract: '', source: 'arXiv' };
  }
  
  const arxivId = arxivIdMatch[1];
  const apiUrl = `http://export.arxiv.org/api/query?id_list=${arxivId}`;
  
  const response = await fetch(apiUrl, { timeout: 10000 });
  const xmlText = await response.text();
  
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
  
  return { url, title, authors, abstract, source: 'arXiv' };
}

// Serve frontend for all non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============== ERROR HANDLING ==============

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// ============== GRACEFUL SHUTDOWN ==============

process.on('SIGTERM', () => {
  console.log('📴 SIGTERM received, shutting down gracefully...');
  server.close(() => {
    db.saveDatabase(() => {
      console.log('💾 Database saved');
      process.exit(0);
    });
  });
});

process.on('SIGINT', () => {
  console.log('📴 SIGINT received, shutting down gracefully...');
  server.close(() => {
    db.saveDatabase(() => {
      console.log('💾 Database saved');
      process.exit(0);
    });
  });
});

// ============== START SERVER ==============

initDatabase().then(() => {
  server.listen(PORT, () => {
    console.log(`📚 Paper Bookmark server running on http://localhost:${PORT}`);
    console.log(`🔄 WebSocket server ready for real-time sync`);
    console.log(`🔒 Security: Helmet enabled, Rate limiting: ${RATE_LIMIT_MAX}/${RATE_LIMIT_WINDOW/60000}min`);
    if (API_KEY) {
      console.log(`🔑 API Key authentication enabled`);
    } else {
      console.log(`⚠️  API Key authentication disabled (set API_KEY env var to enable)`);
    }
  });
});
