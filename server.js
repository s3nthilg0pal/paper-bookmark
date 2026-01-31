const express = require('express');
const cors = require('cors');
const path = require('path');
const loki = require('lokijs');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// Track SSE clients for real-time updates
const sseClients = new Set();

// Broadcast update to all connected SSE clients
function broadcast(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach((res) => {
    res.write(message);
  });
}

// Initialize LokiJS database
let papers;
const db = new loki(path.join(__dirname, 'data', 'papers.db'), {
  autoload: true,
  autoloadCallback: initializeDatabase,
  autosave: true,
  autosaveInterval: 4000
});

function initializeDatabase() {
  // Get or create the papers collection
  papers = db.getCollection('papers');
  if (!papers) {
    papers = db.addCollection('papers', {
      unique: ['url'],
      indices: ['dateAdded', 'title']
    });
  }
  console.log('📁 Database initialized');
}

// Generate unique ID
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============== SSE ENDPOINT ==============

// Server-Sent Events endpoint for real-time updates (Cloudflare friendly)
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  res.flushHeaders();

  // Send initial connection event
  res.write(`event: connected\ndata: ${JSON.stringify({ clientCount: sseClients.size + 1 })}\n\n`);

  sseClients.add(res);
  console.log(`📱 SSE client connected. Total: ${sseClients.size}`);

  // Send keepalive every 30 seconds to prevent timeout
  const keepAlive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 30000);

  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
    console.log(`📱 SSE client disconnected. Total: ${sseClients.size}`);
  });
});

// ============== API ROUTES ==============

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
          (paper.tags && paper.tags.some(t => t.toLowerCase().includes(searchLower)))
        );
      });
    }
    
    // Tag filter
    if (tag) {
      results = results.where((paper) => paper.tags && paper.tags.includes(tag));
    }
    
    // Sort
    const isDescending = order === 'desc';
    results = results.simplesort(sort, isDescending);
    
    // Map to clean response (remove LokiJS metadata)
    const data = results.data().map(cleanPaper);
    
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET single paper by ID
app.get('/api/papers/:id', (req, res) => {
  try {
    const paper = papers.findOne({ _id: req.params.id });
    
    if (!paper) {
      return res.status(404).json({ success: false, error: 'Paper not found' });
    }
    
    res.json({ success: true, data: cleanPaper(paper) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST new paper
app.post('/api/papers', (req, res) => {
  try {
    const { url, title, authors, abstract, tags, source } = req.body;
    
    if (!url) {
      return res.status(400).json({ success: false, error: 'URL is required' });
    }
    
    // Check if paper already exists
    const existing = papers.findOne({ url });
    if (existing) {
      return res.status(409).json({ success: false, error: 'Paper already exists', data: cleanPaper(existing) });
    }
    
    const paper = {
      _id: generateId(),
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
    
    const newPaper = papers.insert(paper);
    const cleanedPaper = cleanPaper(newPaper);
    
    // Broadcast to all connected clients
    broadcast('paper:created', cleanedPaper);
    
    res.status(201).json({ success: true, data: cleanedPaper });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT update paper
app.put('/api/papers/:id', (req, res) => {
  try {
    const { title, authors, abstract, tags, url } = req.body;
    
    const paper = papers.findOne({ _id: req.params.id });
    
    if (!paper) {
      return res.status(404).json({ success: false, error: 'Paper not found' });
    }
    
    // Update fields
    if (title) paper.title = title;
    if (authors !== undefined) paper.authors = authors;
    if (abstract !== undefined) paper.abstract = abstract;
    if (tags) paper.tags = tags;
    if (url) {
      paper.url = url;
      paper.source = detectSource(url);
    }
    
    papers.update(paper);
    const cleanedPaper = cleanPaper(paper);
    
    // Broadcast to all connected clients
    broadcast('paper:updated', cleanedPaper);
    
    res.json({ success: true, data: cleanedPaper });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE paper
app.delete('/api/papers/:id', (req, res) => {
  try {
    const paper = papers.findOne({ _id: req.params.id });
    
    if (!paper) {
      return res.status(404).json({ success: false, error: 'Paper not found' });
    }
    
    papers.remove(paper);
    
    // Broadcast to all connected clients
    broadcast('paper:deleted', { _id: req.params.id });
    
    res.json({ success: true, message: 'Paper deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Track paper access (when user clicks to open)
app.post('/api/papers/:id/access', (req, res) => {
  try {
    const paper = papers.findOne({ _id: req.params.id });
    
    if (!paper) {
      return res.status(404).json({ success: false, error: 'Paper not found' });
    }
    
    paper.lastAccessed = new Date().toISOString();
    paper.accessCount = (paper.accessCount || 0) + 1;
    papers.update(paper);
    
    res.json({ success: true, data: cleanPaper(paper) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
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

// Remove LokiJS internal fields from response
function cleanPaper(paper) {
  if (!paper) return null;
  const { $loki, meta, ...clean } = paper;
  return clean;
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

// Start server
app.listen(PORT, () => {
  console.log(`📚 Paper Bookmark server running on http://localhost:${PORT}`);
  console.log(`🔄 SSE ready for real-time sync (Cloudflare compatible)`);
});

